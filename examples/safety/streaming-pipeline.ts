import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import fs from 'node:fs';

/**
 * Backpressured Stream Pipeline Example
 * 
 * Streams large files or datasets from disk/network without ballooning the Node.js V8 heap.
 * Supports both idiomatic Async Generators and safe Transform streams.
 */

// Approach 1: Modern Idiomatic Node.js Async Generator Pipeline
export async function streamWithAsyncGenerator(
  inputFilePath: string,
  outputFilePath: string,
  processChunk: (line: string) => Promise<string>
): Promise<void> {
  async function* transformStage(source: AsyncIterable<Buffer>) {
    for await (const chunk of source) {
      const transformed = await processChunk(chunk.toString('utf8'));
      yield Buffer.from(transformed, 'utf8');
    }
  }

  // stream/promises pipeline handles backpressure and cleans up all descriptors on error
  await pipeline(
    fs.createReadStream(inputFilePath),
    transformStage,
    fs.createWriteStream(outputFilePath)
  );
}

// Approach 2: Robust Transform Stream with Proper Error Handling
export async function streamWithTransformStream(
  inputFilePath: string,
  outputFilePath: string,
  transformChunk: (chunk: string) => string
): Promise<void> {
  const lineTransformer = new Transform({
    transform(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null, data?: Buffer) => void) {
      try {
        const transformed = transformChunk(chunk.toString('utf8'));
        callback(null, Buffer.from(transformed, 'utf8'));
      } catch (err) {
        // Enforces stream contract: errors must be passed to callback
        callback(err instanceof Error ? err : new Error(String(err)));
      }
    },
  });

  await pipeline(
    fs.createReadStream(inputFilePath),
    lineTransformer,
    fs.createWriteStream(outputFilePath)
  );
}
