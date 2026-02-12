#!/bin/bash

set -e

REPO="williamfzc/baton"
INSTALL_DIR="${XDG_BIN_HOME:-$HOME/.local/bin}"
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
FILENAME="baton-$PLATFORM-$ARCH.tar.gz"
DOWNLOAD_URL="https://github.com/$REPO/releases/download/$LATEST_VERSION/$FILENAME"

echo "正在下载 baton..."
curl -L -o /tmp/baton.tar.gz "$DOWNLOAD_URL"

echo "正在解压..."
tar -xzf /tmp/baton.tar.gz -C /tmp
chmod +x /tmp/baton

echo "正在安装..."
mkdir -p "$INSTALL_DIR"
mv /tmp/baton "$INSTALL_DIR/$BINARY_NAME"

echo "✓ baton 安装成功！"
if ! echo ":$PATH:" | grep -q ":$INSTALL_DIR:"; then
  echo "⚠️  当前 PATH 未包含 $INSTALL_DIR"
  echo "请将以下内容加入 shell 配置（如 ~/.zshrc 或 ~/.bashrc）："
  echo "export PATH=\"$INSTALL_DIR:\$PATH\""
fi
echo "运行 'baton --help' 开始使用"
