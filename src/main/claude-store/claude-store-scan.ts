import { stat } from 'fs/promises'

export const FILE_SCAN_BATCH_SIZE = 4

export type ScannedFileStat = {
  path: string
  mtimeMs: number
  size: number
}

export async function yieldToEventLoop(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0))
}

export async function getProcessedFileStat(filePath: string): Promise<ScannedFileStat> {
  const fileStat = await stat(filePath)
  return {
    path: filePath,
    mtimeMs: fileStat.mtimeMs,
    size: fileStat.size
  }
}

export async function scanFilesInBatches<T>(
  files: string[],
  processFile: (filePath: string) => Promise<T>,
  onResult: (result: T) => void
): Promise<void> {
  for (let index = 0; index < files.length; index += FILE_SCAN_BATCH_SIZE) {
    const batch = files.slice(index, index + FILE_SCAN_BATCH_SIZE)
    const results = await Promise.all(batch.map((filePath) => processFile(filePath)))
    for (const result of results) {
      onResult(result)
    }
    // Why: transcript scans run in Electron's main process. Small parallel
    // batches cut independent file I/O without letting Settings stay blocked.
    if (index + batch.length < files.length) {
      await yieldToEventLoop()
    }
  }
}
