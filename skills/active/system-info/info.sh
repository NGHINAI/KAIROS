#!/bin/bash
# System info skill (macOS) — outputs JSON with CPU, memory, uptime
LOAD=$(uptime | sed 's/.*load averages: //' | awk '{print $1}')
BOOT_SEC=$(sysctl -n kern.boottime | grep -oE 'sec = [0-9]+' | head -1 | awk '{print $3}')
UPTIME_SEC=$(($(date +%s) - BOOT_SEC))
CPU_PCT=$(top -l 1 -n 0 | grep "CPU usage" | awk '{print $3}' | tr -d '%')
MEM_PRESSURE=$(memory_pressure 2>/dev/null | grep "System-wide memory free percentage" | awk '{print $5}' | tr -d '%' || echo "")

if [ -z "$MEM_PRESSURE" ]; then
  MEM_FREE=null
else
  MEM_FREE=$MEM_PRESSURE
fi

UPTIME_HUMAN=$(echo $UPTIME_SEC | awk '{h=int($1/3600); m=int(($1%3600)/60); printf "%dh%dm", h, m}')

cat <<EOF
{
  "load_1min": $LOAD,
  "uptime_seconds": $UPTIME_SEC,
  "uptime_human": "$UPTIME_HUMAN",
  "cpu_percent": $CPU_PCT,
  "memory_free_percent": $MEM_FREE,
  "platform": "darwin"
}
EOF
