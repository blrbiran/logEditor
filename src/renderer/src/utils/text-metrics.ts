export const countLines = (value: string): number => {
  if (!value.length) {
    return 1
  }

  let breaks = 0
  for (let index = 0; index < value.length; index += 1) {
    if (value.charCodeAt(index) === 10) {
      breaks += 1
    }
  }

  const endsWithBreak = value.charCodeAt(value.length - 1) === 10
  const total = endsWithBreak ? breaks : breaks + 1
  return Math.max(1, total)
}

export const countLinesForAppend = (value: string, previousEndedWithLineBreak: boolean): number => {
  if (!value.length) {
    return 0
  }
  const total = countLines(value)
  return previousEndedWithLineBreak ? total : Math.max(0, total - 1)
}
