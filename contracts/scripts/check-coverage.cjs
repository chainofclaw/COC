/**
 * Coverage Threshold Checker
 *
 * Checks that contract test coverage meets minimum thresholds.
 * Run after: npx hardhat coverage
 *
 * Reads coverage-final.json and verifies line/branch/function coverage.
 */

const fs = require("fs")
const path = require("path")

const COVERAGE_FILE = path.join(__dirname, "..", "coverage", "coverage-final.json")
const THRESHOLDS = {
  lines: 80,
  branches: 70,
  functions: 80,
  statements: 80,
}

function main() {
  if (!fs.existsSync(COVERAGE_FILE)) {
    console.error("Coverage file not found. Run 'npx hardhat coverage' first.")
    process.exit(1)
  }

  const coverage = JSON.parse(fs.readFileSync(COVERAGE_FILE, "utf-8"))
  let totalStatements = 0
  let coveredStatements = 0
  let totalBranches = 0
  let coveredBranches = 0
  let totalFunctions = 0
  let coveredFunctions = 0
  let totalLines = 0
  let coveredLines = 0

  for (const [filePath, data] of Object.entries(coverage)) {
    // Skip test contracts
    if (filePath.includes("test-contracts")) continue

    // Statements
    for (const count of Object.values(data.s)) {
      totalStatements++
      if (count > 0) coveredStatements++
    }

    // Branches
    for (const count of Object.values(data.b)) {
      for (const c of count) {
        totalBranches++
        if (c > 0) coveredBranches++
      }
    }

    // Functions
    for (const count of Object.values(data.f)) {
      totalFunctions++
      if (count > 0) coveredFunctions++
    }

    // Lines (approximate from statementMap)
    const lineSet = new Set()
    const coveredLineSet = new Set()
    for (const [id, loc] of Object.entries(data.statementMap)) {
      for (let l = loc.start.line; l <= loc.end.line; l++) {
        lineSet.add(l)
        if (data.s[id] > 0) coveredLineSet.add(l)
      }
    }
    totalLines += lineSet.size
    coveredLines += coveredLineSet.size
  }

  const pct = (covered, total) => total === 0 ? 100 : ((covered / total) * 100).toFixed(1)

  const results = {
    lines: parseFloat(pct(coveredLines, totalLines)),
    branches: parseFloat(pct(coveredBranches, totalBranches)),
    functions: parseFloat(pct(coveredFunctions, totalFunctions)),
    statements: parseFloat(pct(coveredStatements, totalStatements)),
  }

  console.log("Coverage Results:")
  console.log(`  Lines:      ${results.lines}% (threshold: ${THRESHOLDS.lines}%)`)
  console.log(`  Branches:   ${results.branches}% (threshold: ${THRESHOLDS.branches}%)`)
  console.log(`  Functions:  ${results.functions}% (threshold: ${THRESHOLDS.functions}%)`)
  console.log(`  Statements: ${results.statements}% (threshold: ${THRESHOLDS.statements}%)`)

  let failed = false
  for (const [metric, threshold] of Object.entries(THRESHOLDS)) {
    if (results[metric] < threshold) {
      console.error(`FAIL: ${metric} coverage ${results[metric]}% < ${threshold}%`)
      failed = true
    }
  }

  if (failed) {
    process.exit(1)
  } else {
    console.log("\nAll coverage thresholds met!")
  }
}

main()
