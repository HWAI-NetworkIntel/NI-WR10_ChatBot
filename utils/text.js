'use strict'

/** Lowercase letters and digits only: "Fort Bend" -> "fortbend". */
function compact(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, '')
}

/** Edit distance with adjacent swaps: "cenetne" is 1 away from "centene". */
function typoDistance(a, b) {
  const rows = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)])
  for (let j = 1; j <= b.length; j += 1) rows[0][j] = j
  for (let i = 1; i <= a.length; i += 1) {
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      rows[i][j] = Math.min(rows[i - 1][j] + 1, rows[i][j - 1] + 1, rows[i - 1][j - 1] + cost)
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) rows[i][j] = Math.min(rows[i][j], rows[i - 2][j - 2] + 1)
    }
  }
  return rows[a.length][b.length]
}

/** How many typos a name of this length may carry: none under 5 letters, 1 at 5, 2 from 6 ("hariss" -> "harris"). */
function typoAllowance(length) {
  if (length < 5) return 0
  return length >= 6 ? 2 : 1
}

module.exports = { compact, typoDistance, typoAllowance }
