import { pipeline } from 'stream/promises';
import { Transform } from 'stream';
import fs from 'fs';

/**
 * Backpressured Stream Pipeline Example
 * Streams data from disk or network without ballooning the Node.js V8 heap.
 */
export async function streamFileToTransformer(
  inputFilePath: string,
  outputFilePath: string,
  transformChunk: (chunk: string) => string
): Promise<void> {
  const lineTransformer = new Transform({
    transform(chunk: Buffer, encoding, callback) {
      try {
        const transformed = transformChunk(chunk.toString('utf8'));
        callback(null, Buffer.from(transformed, 'utf8'));
      } catch (err) {
        callback(err as Error);
      }
    },
  });

  // Automatically manages backpressure and safely cleans up file descriptors on error
  await pipeline(
    fs.createReadStream(inputFilePath),
    lineTransformer,
    fs.createWriteStream(outputFilePath)
  );
}
