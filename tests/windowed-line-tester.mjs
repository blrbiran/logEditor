#!/usr/bin/env node
import { createReadStream } from 'fs'
import { promises as fs } from 'fs'
import { TextDecoder } from 'util'

const textDecoder = new TextDecoder('utf-8')

const DEFAULT_CHUNK = 512 * 1024
const DEFAULT_OVERLAP = 64 * 1024

const parseArgs = (argv) => {
  const args = {}
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (token.startsWith('--')) {
      const key = token.slice(2)
      const next = argv[index + 1]
      if (!next || next.startsWith('--')) {
        args[key] = true
        continue
      }
      args[key] = next
      index += 1
    } else if (token.startsWith('-')) {
      const key = token.slice(1)
      const next = argv[index + 1]
      if (!next || next.startsWith('-')) {
        args[key] = true
        continue
      }
      args[key] = next
      index += 1
    }
  }
  return args
}

const clamp = (value, min, max) => Math.min(Math.max(value, min), max)

const getLineBreakStats = (value) => {
  let breaks = 0
  let endsWithBreak = false
  for (let index = 0; index < value.length; index += 1) {
    if (value.charCodeAt(index) === 10) {
      breaks += 1
      endsWithBreak = true
    } else {
      endsWithBreak = false
    }
  }
  return { breaks, endsWithBreak }
}

const countLinesInText = (value, stats) => {
  if (!value.length) {
    return 1
  }
  const metrics = stats ?? getLineBreakStats(value)
  if (metrics.breaks === 0) {
    return 1
  }
  return metrics.endsWithBreak ? Math.max(1, metrics.breaks) : metrics.breaks + 1
}

const countLinesInFile = async (filePath) => {
  return await new Promise((resolve, reject) => {
    let count = 0
    let endsWithBreak = false
    let sawData = false
    const stream = createReadStream(filePath, {
      encoding: 'utf-8',
      highWaterMark: 256 * 1024
    })
    stream.on('data', (chunk) => {
      if (!chunk.length) {
        return
      }
      sawData = true
      for (let index = 0; index < chunk.length; index += 1) {
        if (chunk.charCodeAt(index) === 10) {
          count += 1
        }
      }
      endsWithBreak = chunk.charCodeAt(chunk.length - 1) === 10
    })
    stream.on('end', () => {
      if (!sawData) {
        resolve(1)
        return
      }
      const total = endsWithBreak ? Math.max(1, count) : count + 1
      resolve(total)
    })
    stream.on('error', (error) => reject(error))
  })
}

const createLineCache = () => new Map([[0, 1]])

const getLineNumberForOffset = async (filePath, offset, cache) => {
  if (offset <= 0) {
    return 1
  }
  let nearestOffset = 0
  let nearestLine = 1
  for (const [cachedOffset, line] of cache.entries()) {
    if (cachedOffset <= offset && cachedOffset >= nearestOffset) {
      nearestOffset = cachedOffset
      nearestLine = line
    }
  }
  if (nearestOffset === offset) {
    return nearestLine
  }

  const handle = await fs.open(filePath, 'r')
  try {
    const bufferSize = 256 * 1024
    const buffer = Buffer.alloc(bufferSize)
    let currentOffset = nearestOffset
    let currentLine = nearestLine
    while (currentOffset < offset) {
      const toRead = Math.min(bufferSize, offset - currentOffset)
      const { bytesRead } = await handle.read(buffer, 0, toRead, currentOffset)
      if (bytesRead === 0) {
        break
      }
      for (let index = 0; index < bytesRead; index += 1) {
        if (buffer[index] === 10) {
          currentLine += 1
        }
      }
      currentOffset += bytesRead
    }
    cache.set(offset, currentLine)
    return currentLine
  } finally {
    await handle.close()
  }
}

const readFileRange = async (filePath, start, length, cache) => {
  const handle = await fs.open(filePath, 'r')
  try {
    const stats = await handle.stat()
    const totalSize = stats.size
    const safeStart = clamp(Number.isFinite(start) ? Math.floor(start) : 0, 0, Math.max(totalSize - 1, 0))
    const safeLength = Number.isFinite(length) && length > 0 ? Math.floor(length) : DEFAULT_CHUNK
    if (safeStart >= totalSize) {
      return { filePath, start: totalSize, end: totalSize, content: '', totalSize, hasMore: false, startLine: await getLineNumberForOffset(filePath, totalSize, cache), lineCount: 1 }
    }
    const endPosition = Math.min(totalSize, safeStart + safeLength)
    const buffer = Buffer.alloc(endPosition - safeStart)
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, safeStart)
    const content = textDecoder.decode(buffer.subarray(0, bytesRead))
    const nextEnd = safeStart + bytesRead
    const startLine = await getLineNumberForOffset(filePath, safeStart, cache)
    const statsSummary = getLineBreakStats(content)
    const lineCount = countLinesInText(content, statsSummary)
    cache.set(nextEnd, startLine + statsSummary.breaks)
    return {
      filePath,
      start: safeStart,
      end: nextEnd,
      content,
      totalSize,
      hasMore: nextEnd < totalSize,
      startLine,
      lineCount,
      chunkBreaks: statsSummary.breaks,
      endsWithBreak: statsSummary.endsWithBreak
    }
  } finally {
    await handle.close()
  }
}

const args = parseArgs(process.argv.slice(2))
const filePath = args.file || args.f
if (!filePath) {
  console.error('Usage: node tests/windowed-line-tester.mjs --file <path> [--chunk bytes] [--overlap bytes] [--steps n] [--ratio 0-1]')
  process.exit(1)
}

const chunkSize = args.chunk ? Number(args.chunk) : DEFAULT_CHUNK
const overlap = args.overlap ? Number(args.overlap) : Math.min(DEFAULT_OVERLAP, Math.floor(chunkSize / 2))
const steps = args.steps ? Number(args.steps) : 3
const ratio = args.ratio !== undefined ? Number(args.ratio) : null

const stats = await fs.stat(filePath)
const fileSize = stats.size
const totalLines = await countLinesInFile(filePath)

const lineCache = createLineCache()

const ranges = []
let start = 0
if (ratio !== null && Number.isFinite(ratio)) {
  const safeRatio = clamp(ratio, 0, 1)
  const anchor = Math.round(fileSize * safeRatio)
  start = clamp(anchor - Math.floor(chunkSize / 2), 0, Math.max(0, fileSize - chunkSize))
}

for (let step = 0; step < steps; step += 1) {
  const range = await readFileRange(filePath, start, chunkSize, lineCache)
  range.index = step
  ranges.push(range)
  if (!range.hasMore) {
    break
  }
  const maxStart = Math.max(0, fileSize - chunkSize)
  const nextStart = Math.min(maxStart, Math.max(range.end - overlap, start))
  if (nextStart === start) {
    break
  }
  start = nextStart
}

const summarizeRange = (range) => {
  const startLine = range.startLine
  const endLine = range.startLine + range.lineCount - 1
  const startCommand = `sed -n '${startLine}p' ${filePath}`
  const endCommand = `sed -n '${endLine}p' ${filePath}`
  return {
    step: range.index,
    bytes: `${range.start}-${range.end} (${range.end - range.start} bytes)` ,
    startLine,
    endLine,
    chunkLines: range.lineCount,
    chunkBreaks: range.chunkBreaks,
    endsWithBreak: range.endsWithBreak,
    hasMore: range.hasMore,
    sampleCommands: { start: startCommand, end: endCommand }
  }
}

console.log(`File: ${filePath}`)
console.log(`Size: ${fileSize.toLocaleString()} bytes`)
console.log(`Total lines (stream count): ${totalLines.toLocaleString()}`)
console.log(`Chunk size: ${chunkSize.toLocaleString()} bytes · Overlap: ${overlap.toLocaleString()} bytes`)
if (ratio !== null) {
  console.log(`Anchor ratio: ${ratio}`)
}
console.log('--- Ranges ---')
ranges.forEach((range) => {
  const summary = summarizeRange(range)
  console.log(JSON.stringify(summary, null, 2))
})
