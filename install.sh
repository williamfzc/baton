#!/bin/bash

set -e

REPO="williamfzc/baton"
INSTALL_DIR="/usr/local/bin"
BINARY_NAME="baton"

# 检测操作系统和架构
OS=$(uname -s | tr '[:upper:]' '[:lower:]')
ARCH=$(uname -m)

case $OS in
  linux)
    PLATFORM="linux"
    ;;
  darwin)
    PLATFORM="darwin"
    ;;
  *)
    echo "不支持的操作系统: $OS"
    exit 1
    ;;
esac

case $ARCH in
  x86_64|amd64)
    ARCH="x64"
    ;;
  arm64|aarch64)
    ARCH="arm64"
    ;;
  *)
    echo "不支持的架构: $ARCH"
    exit 1
    ;;
esac

echo "正在检测最新版本..."
LATEST_VERSION=$(curl -s "https://api.github.com/repos/$REPO/releases/latest" | grep '"tag_name":' | sed -E 's/.*"([^"]+)".*/\1/')

if [ -z "$LATEST_VERSION" ]; then
  echo "无法获取最新版本"
  exit 1
fi

echo "最新版本: $LATEST_VERSION"
echo "平台: $PLATFORM-$ARCH"

# 构建下载 URL
FILENAME="baton-$PLATFORM-$ARCH"
DOWNLOAD_URL="https://github.com/$REPO/releases/download/$LATEST_VERSION/$FILENAME"

echo "正在下载 baton..."
curl -L -o /tmp/baton "$DOWNLOAD_URL"

echo "正在安装..."
chmod +x /tmp/baton

# 检查是否有权限写入 INSTALL_DIR
if [ -w "$INSTALL_DIR" ]; then
  mv /tmp/baton "$INSTALL_DIR/$BINARY_NAME"
else
  echo "需要管理员权限来安装到 $INSTALL_DIR"
  sudo mv /tmp/baton "$INSTALL_DIR/$BINARY_NAME"
fi

echo "✓ baton 安装成功！"
echo "运行 'baton --help' 开始使用"
