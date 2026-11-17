const ZERO_MONEY = /(?:\$\s*0(?:[.,]0{1,2})?(?![\d.,])(?:\s*(?:MXN|USD|pesos?|d[oó]lares?))?|\b0(?:[.,]0{1,2})?(?![\d.,])\s*(?:MXN|USD|pesos?|d[oó]lares?)\b)/gi

export function hasFreeCoursePrice(price: string): boolean {
  const value = price.trim()
  return /(?:^|:\s*)0(?:[.,]0{1,2})?(?=\s*(?:\/|;|$))/.test(value) || new RegExp(ZERO_MONEY.source, 'i').test(value)
}

export function formatFreeCourseAnswer(answer: string, hasFreeCourse: boolean, hasOtherOffers: boolean): string {
  if (!hasFreeCourse || hasOtherOffers) return answer
  const zero = ZERO_MONEY.source
  return answer
    .replace(new RegExp(`\\b(?:tiene|tendr[aá])\\s+(?:un\\s+)?(?:precio|costo)\\s+de\\s+${zero}`, 'gi'), 'es gratis')
    .replace(new RegExp(`\\b(?:el\\s+)?(?:precio|costo)\\s*(?:es\\s*(?:de)?|:|de)\\s*${zero}`, 'gi'), 'es gratis')
    .replace(ZERO_MONEY, 'gratis')
}
