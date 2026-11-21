import { pipeline } from 'node:stream/promises';
import { StringDecoder } from 'node:string_decoder';
import readline from 'node:readline';
import fs from 'node:fs';

/**
 * Backpressured Stream Pipeline Example
 * 
 * Streams large files or datasets from disk/network without ballooning the Node.js V8 heap.
 * Safely handles chunk boundaries, line framing, and multi-byte UTF-8 characters.
 */

/**
 * Approach 1: Line-by-Line Processing with node:readline
 * 
 * Recommended for line-oriented data (CSV, JSONL, logs).
 * node:readline automatically handles line framing across arbitrary byte chunks,
 * CRLF/LF normalization, and multi-byte UTF-8 character splitting.
 */
export async function streamLinesWithReadline(
  inputFilePath: string,
  outputFilePath: string,
  processLine: (line: string) => Promise<string>
): Promise<void> {
  const readStream = fs.createReadStream(inputFilePath);
  const writeStream = fs.createWriteStream(outputFilePath);
  const rl = readline.createInterface({
    input: readStream,
    crlfDelay: Infinity, // Normalizes \r\n and \n
  });

  try {
    for await (const line of rl) {
      const transformed = await processLine(line);
      const canWrite = writeStream.write(transformed + '\n');
      if (!canWrite) {
        // Enforce backpressure when kernel write buffer is full
        await new Promise((resolve) => writeStream.once('drain', resolve));
      }
    }
  } finally {
    writeStream.end();
  }
}

/**
 * Approach 2: Composable Async Generator Pipeline with StringDecoder
 * 
 * Uses StringDecoder to safely assemble UTF-8 characters and frames newline-delimited
 * records across arbitrary stream chunk boundaries before processing.
 */
export async function streamLinesWithPipeline(
  inputFilePath: string,
  outputFilePath: string,
  processLine: (line: string) => Promise<string>
): Promise<void> {
  async function* lineFramingStage(source: AsyncIterable<Buffer>) {
    const decoder = new StringDecoder('utf8');
    let remainder = '';

    for await (const chunk of source) {
      // StringDecoder preserves incomplete multi-byte UTF-8 character bytes until next chunk
      remainder += decoder.write(chunk);
      const lines = remainder.split(/\r?\n/);
      // Keep trailing incomplete fragment in remainder buffer
      remainder = lines.pop() ?? '';

      for (const line of lines) {
        const transformed = await processLine(line);
        yield Buffer.from(transformed + '\n', 'utf8');
      }
    }

    remainder += decoder.end();
    if (remainder.length > 0) {
      const transformed = await processLine(remainder);
      yield Buffer.from(transformed + '\n', 'utf8');
    }
  }

  // stream/promises pipeline handles backpressure and cleans up all descriptors on error
  await pipeline(
    fs.createReadStream(inputFilePath),
    lineFramingStage,
    fs.createWriteStream(outputFilePath)
  );
}
