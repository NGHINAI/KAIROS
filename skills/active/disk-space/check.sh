#!/bin/bash
# Disk space check skill — outputs JSON with usage info
df -k / | tail -1 | awk '{
  total_kb = $2
  used_kb = $3
  avail_kb = $4
  pct = $5
  gsub("%", "", pct)
  printf "{\"total_gb\": %.1f, \"used_gb\": %.1f, \"available_gb\": %.1f, \"percent_used\": %d, \"status\": \"%s\"}",
    total_kb / 1024 / 1024,
    used_kb / 1024 / 1024,
    avail_kb / 1024 / 1024,
    pct,
    (pct >= 90 ? "critical" : pct >= 75 ? "warning" : "healthy")
}'
