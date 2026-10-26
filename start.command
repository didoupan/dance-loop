#!/bin/bash
# Dance Loop 一键启动（macOS）
set -e
cd "$(dirname "$0")"

if ! command -v node >/dev/null 2>&1; then
  echo ""
  echo "未检测到 Node.js。请先安装 Node.js 20.19 或更新版本："
  echo "https://nodejs.org/zh-cn"
  echo ""
  read -r -p "按回车键退出…" _
  exit 1
fi

if [ ! -d node_modules ]; then
  echo "首次运行，正在安装依赖…"
  npm install
fi

echo "正在构建…"
npm run build

IP="$(ipconfig getifaddr en0 2>/dev/null || true)"
if [ -z "$IP" ]; then
  IP="$(ipconfig getifaddr en1 2>/dev/null || true)"
fi

echo ""
echo "────────────────────────────────────────"
echo "  Dance Loop 已启动"
echo "  电脑访问：http://localhost:4173"
if [ -n "$IP" ]; then
  echo "  手机访问：http://$IP:4173"
  echo "  （手机和 Mac 需要连接同一个 Wi-Fi）"
fi
echo "────────────────────────────────────────"
echo ""
echo "关闭这个终端窗口即可停止服务。"
echo ""

( sleep 2; open "http://localhost:4173" >/dev/null 2>&1 || true ) &
npm run preview
