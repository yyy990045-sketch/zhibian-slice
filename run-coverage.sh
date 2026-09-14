#!/usr/bin/env bash
# 知辩 · 覆盖率门禁（US-19：node:test 覆盖率，per-path 阈值，逐 sprint 提升）
# 用法：./run-coverage.sh            # 默认阈值 60（S0 起步）
#       MIN_LINES=80 ./run-coverage.sh
# 说明：只对 src/ 下的核心模块做 per-path 门禁，忽略运行时 shim 与 test 自身。
# 兼容：Node 22 输出 TAP（# tests 8 / # fail 0），Node 24 输出 reporter（ℹ tests 8 / ℹ fail 0 / ℹ  challenge.js | 91.15 …）。
set -euo pipefail

MIN="${MIN_LINES:-60}"
OUT="$(node --experimental-test-coverage --test 'test/unit/*.test.mjs' 2>&1 || true)"

# 1) 测试结果：# tests 或 ℹ tests（node:test 分行输出，兼容 Node 22 TAP 与 Node 24 reporter）
TESTS="$(echo "$OUT" | grep -E '^[#ℹ] +tests ' || true)"
FAILCNT="$(echo "$OUT" | grep -E '^[#ℹ] +fail ' | grep -oE '[0-9]+' || true)"
echo "$TESTS"
[ -n "$TESTS" ] || { echo "FAIL: 未找到测试汇总"; exit 1; }
[ "${FAILCNT:-1}" = "0" ] || { echo "FAIL: 存在失败用例（fail=$FAILCNT）"; exit 1; }

# 2) per-path 门禁：awk 解析 Node 24 覆盖率表格（ℹ  src | … / ℹ  challenge.js | 91.15 | …），
#    也兼容 Node 22 TAP（# src | … / #  challenge.js | 91.15 | …）。
#    只统计 src/ 目录下的核心模块；行内百分比取 line % 列（即第一个 | 后）。
if ! FAILED="$(echo "$OUT" | awk -v min="$MIN" '
  function colval(line) {
    # 取第一个 | 与第二个 | 之间的数字百分比（line % 列）
    n = split(line, cols, "|");
    if (n < 2) return "";
    v = cols[2]; gsub(/[^0-9.]/, "", v);
    return v;
  }
  /^[#ℹ] +[a-zA-Z_][a-zA-Z0-9_]* +\|/ { curdir=$2; gsub(/:.*/,"",curdir); next }
  /^[#ℹ] +[^ |]+\.js +\|/ {
    f=$2; sub(/^/,"",f); gsub(/:.*/,"",f);
    pct = colval($0);
    if (curdir == "src" && f != "" && pct != "") {
      if (pct+0 >= min+0) print "PASS: src/" f " lines " pct "%";
      else { print "FAIL: src/" f " lines " pct "% < " min "%"; bad=1 }
    }
    next
  }
  END { exit bad }
')"; then
  echo "$FAILED"
  echo "FAIL: 存在未达到阈值的 src/ 模块"
  exit 1
fi
echo "$FAILED"
[ -n "$FAILED" ] || { echo "FAIL: 未解析到 src/ 模块覆盖率"; exit 1; }
echo "PASS: 全部 src/ 核心模块覆盖率 ≥ ${MIN}%"
