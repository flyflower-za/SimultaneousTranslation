#!/bin/bash

# 关闭占用指定端口的进程

PORTS=${@:-8080 8765}

echo "查找占用端口的进程..."

for PORT in $PORTS; do
    PID=$(lsof -ti :$PORT 2>/dev/null)
    
    if [ -z "$PID" ]; then
        echo "端口 $PORT 未被占用"
    else
        echo "找到占用端口 $PORT 的进程 PID: $PID"
        ps -p $PID
        kill -9 $PID 2>/dev/null
        echo "已关闭占用端口 $PORT 的进程"
    fi
done

echo "完成"

