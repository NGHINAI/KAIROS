#!/bin/bash
# Count running processes by current user with top names and CPU breakdown

CURRENT_USER=$(whoami)
PS_OUTPUT=$(ps -u "$CURRENT_USER" -o pid=,pcpu=,comm= 2>/dev/null)

if [ -z "$PS_OUTPUT" ]; then
    printf '{"user":"%s","error":"no processes found","total_processes":0,"top5_by_count":[],"top5_by_cpu":[]}\n' "$CURRENT_USER"
    exit 0
fi

TOTAL=$(printf '%s\n' "$PS_OUTPUT" | grep -c .)

# Top 5 process names by count (comm is last field)
TOP5_NAMES=$(printf '%s\n' "$PS_OUTPUT" | awk '{print $NF}' | sort | uniq -c | sort -rn | head -5)

top5_json="["
sep=""
while read -r count name; do
    [ -z "$name" ] && continue
    safe_name=$(printf '%s' "$name" | sed 's/\\/\\\\/g; s/"/\\"/g')
    top5_json+="${sep}{\"name\":\"${safe_name}\",\"count\":${count}}"
    sep=","
done <<< "$TOP5_NAMES"
top5_json+="]"

# Sum CPU by process name, top 5
CPU_BREAKDOWN=$(printf '%s\n' "$PS_OUTPUT" | awk '{cpu[$NF]+=$2} END {for (n in cpu) printf "%.1f %s\n", cpu[n], n}' | sort -rn | head -5)

cpu_json="["
sep=""
while read -r cpu name; do
    [ -z "$name" ] && continue
    safe_name=$(printf '%s' "$name" | sed 's/\\/\\\\/g; s/"/\\"/g')
    cpu_json+="${sep}{\"name\":\"${safe_name}\",\"cpu_percent\":${cpu}}"
    sep=","
done <<< "$CPU_BREAKDOWN"
cpu_json+="]"

printf '{"user":"%s","total_processes":%s,"top5_by_count":%s,"top5_by_cpu":%s}\n' \
    "$CURRENT_USER" "$TOTAL" "$top5_json" "$cpu_json"