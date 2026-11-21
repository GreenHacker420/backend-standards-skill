import { Server } from 'node:http';

export interface DatabaseClient {
  $disconnect(): Promise<void>;
}

export interface RedisConnection {
  quit(): Promise<unknown>;
}

export interface QueueProcessManager {
  pause(): Promise<void>;
  close(): Promise<void>;
}

export interface LoggerClient {
  info(msg: string, ...meta: unknown[]): void;
  error(msg: string, ...meta: unknown[]): void;
  flush?(): Promise<void>;
}

export interface ShutdownDependencies {
  httpServer: Server;
  database?: DatabaseClient;
  redis?: RedisConnection;
  queueManager?: QueueProcessManager;
  logger: LoggerClient;
  drainTimeoutMs?: number;
}

/**
 * Production Graceful Shutdown Coordinator
 * 
 * Strict execution sequence:
 * 1. Mark readiness false (traffic shed by load balancer)
 * 2. Pause queue consumers (prevent new background tasks)
 * 3. Drain in-flight HTTP requests (await httpServer.close())
 * 4. Wait for active workers to complete
 * 5. Close database and Redis pools
 * 6. Flush logs and exit 0
 */
export class ShutdownManager {
  private isTerminating = false;

  public isReady(): boolean {
    return !this.isTerminating;
  }

  public register(deps: ShutdownDependencies): void {
    const {
      httpServer,
      database,
      redis,
      queueManager,
      logger,
      drainTimeoutMs = 15000,
    } = deps;

    const executeShutdown = async (signal: string) => {
      if (this.isTerminating) return;
      this.isTerminating = true;

      logger.info(`Received ${signal}. Starting coordinated graceful shutdown...`);

      // Bounded emergency fallback timer
      const forceExitTimer = setTimeout(() => {
        logger.error(`Shutdown exceeded timeout (${drainTimeoutMs}ms). Forcing process exit.`);
        process.exit(1);
      }, drainTimeoutMs);
      forceExitTimer.unref();

      try {
        // Step 1: Stop accepting new queue jobs
        if (queueManager) {
          logger.info('Pausing queue consumers...');
          await queueManager.pause();
        }

        // Step 2: Drain in-flight HTTP connections (PROMISE-AWAITED)
        logger.info('Draining in-flight HTTP requests...');
        await new Promise<void>((resolve, reject) => {
          httpServer.close((err?: Error) => {
            if (err) return reject(err);
            resolve();
          });
        });
        logger.info('HTTP server closed. All in-flight requests drained.');

        // Step 3: Complete or abort background queue workers
        if (queueManager) {
          logger.info('Closing queue workers...');
          await queueManager.close();
        }

        // Step 4: Disconnect Database connection pool
        if (database) {
          logger.info('Disconnecting database pool...');
          await database.$disconnect();
          logger.info('Database pool closed.');
        }

        // Step 5: Disconnect Redis
        if (redis) {
          logger.info('Closing Redis connections...');
          await redis.quit();
          logger.info('Redis closed.');
        }

        clearTimeout(forceExitTimer);
        logger.info('Graceful shutdown completed successfully.');

        // Step 6: Flush logger transports & pending telemetry buffers
        if (logger.flush) {
          await logger.flush();
        }

        // Node.js Best Practice: set exitCode and allow event loop to drain naturally
        // process.exit() terminates immediately, potentially dropping pending stdout/stderr writes
        process.exitCode = 0;
      } catch (err) {
        logger.error('Error encountered during graceful shutdown:', err);
        process.exit(1);
      }
    };

    process.on('SIGTERM', () => void executeShutdown('SIGTERM'));
    process.on('SIGINT', () => void executeShutdown('SIGINT'));
  }
}

export const shutdownManager = new ShutdownManager();
