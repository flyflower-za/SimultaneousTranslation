#!/bin/bash

# 生成自签名 SSL 证书用于 HTTPS 服务器

CERT_DIR="ssl"
CERT_FILE="$CERT_DIR/cert.pem"
KEY_FILE="$CERT_DIR/key.pem"

echo "生成 SSL 证书..."

# 创建 ssl 目录
mkdir -p $CERT_DIR

# 生成自签名证书（有效期 365 天）
openssl req -x509 -newkey rsa:4096 -nodes \
    -keyout $KEY_FILE \
    -out $CERT_FILE \
    -days 365 \
    -subj "/C=CN/ST=State/L=City/O=Organization/CN=localhost" \
    -addext "subjectAltName=DNS:localhost,DNS:*.local,IP:127.0.0.1,IP:10.0.0.32"

if [ $? -eq 0 ]; then
    echo "✓ SSL 证书生成成功！"
    echo "  证书文件: $CERT_FILE"
    echo "  密钥文件: $KEY_FILE"
    echo ""
    echo "注意：这是自签名证书，浏览器会显示安全警告。"
    echo "在移动设备上访问时，需要点击'高级' -> '继续访问'来接受证书。"
else
    echo "✗ SSL 证书生成失败"
    exit 1
fi

