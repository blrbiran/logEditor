export const countLines = (value: string): number => {
  if (!value.length) {
    return 1
  }

  let count = 1
  for (let index = 0; index < value.length; index += 1) {
    if (value.charCodeAt(index) === 10) {
      count += 1
    }
  }
  return count
}

export const countLinesForAppend = (value: string, previousEndedWithLineBreak: boolean): number => {
  if (!value.length) {
    return 0
  }
  const total = countLines(value)
  return previousEndedWithLineBreak ? total : Math.max(0, total - 1)
}
