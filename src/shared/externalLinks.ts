/** Web links clicked by the user may open in their browser; executable/custom schemes may not. */
export function isWebLink(value: string): boolean {
  try {
    const url = new URL(value)
    return (url.protocol === 'https:' || url.protocol === 'http:') && !!url.hostname
  } catch {
    return false
  }
}
