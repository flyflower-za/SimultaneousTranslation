# 生成自签名 SSL 证书用于 HTTPS 服务器（PowerShell 版本）

$CERT_DIR = "ssl"
$CERT_FILE = Join-Path $CERT_DIR "cert.pem"
$KEY_FILE = Join-Path $CERT_DIR "key.pem"

Write-Host "生成 SSL 证书..."

# 创建 ssl 目录
New-Item -ItemType Directory -Force -Path $CERT_DIR | Out-Null

# 优先使用 openssl（与 generate_cert.sh 一致）
$openssl = Get-Command openssl -ErrorAction SilentlyContinue
if ($openssl) {
    & openssl req -x509 -newkey rsa:4096 -nodes `
        -keyout $KEY_FILE `
        -out $CERT_FILE `
        -days 365 `
        -subj "/C=CN/ST=State/L=City/O=Organization/CN=localhost" `
        -addext "subjectAltName=DNS:localhost,DNS:*.local,IP:127.0.0.1,IP:10.0.0.32"

    if ($LASTEXITCODE -eq 0) {
        Write-Host "✓ SSL 证书生成成功！"
        Write-Host "  证书文件: $CERT_FILE"
        Write-Host "  密钥文件: $KEY_FILE"
        Write-Host ""
        Write-Host "注意：这是自签名证书，浏览器会显示安全警告。"
        Write-Host "在移动设备上访问时，需要点击'高级' -> '继续访问'来接受证书。"
        exit 0
    }
    else {
        Write-Host "✗ SSL 证书生成失败"
        exit 1
    }
}

# 没有 openssl 时，使用 .NET 创建自签名证书并导出 PEM
Write-Host "未找到 openssl，使用 .NET 创建证书..."

$san = New-Object System.Collections.Generic.List[string]
$san.Add("dns=localhost")
$san.Add("dns=*.local")
$san.Add("ip=127.0.0.1")
$san.Add("ip=10.0.0.32")

$cert = New-SelfSignedCertificate `
    -Subject "CN=localhost, O=Organization, L=City, S=State, C=CN" `
    -DnsName @("localhost", "*.local") `
    -NotAfter (Get-Date).AddDays(365) `
    -KeyLength 4096 `
    -KeyExportPolicy Exportable `
    -KeyAlgorithm RSA `
    -HashAlgorithm SHA256 `
    -TextExtension @("2.5.29.17={text}$($san -join '&')") `
    -CertStoreLocation "Cert:\CurrentUser\My"

$pwdStr = [System.Web.Security.Membership]::GeneratePassword(24, 4)
$securePwd = ConvertTo-SecureString -String $pwdStr -Force -AsPlainText

# 导出 PFX 到临时文件再转为 PEM
$pfxFile = Join-Path $env:TEMP "$($cert.Thumbprint).pfx"
Export-PfxCertificate -Cert $cert -FilePath $pfxFile -Password $securePwd | Out-Null
Remove-Item "Cert:\CurrentUser\My\$($cert.Thumbprint)" -Force

$certPem = Join-Path $env:TEMP "$($cert.Thumbprint)_cert.pem"
$keyPem = Join-Path $env:TEMP "$($cert.Thumbprint)_key.pem"

if (Get-Command certutil -ErrorAction SilentlyContinue) {
    # certutil 导出证书部分
    certutil -encode $pfxFile $certPem 2>$null | Out-Null
    if (-not (Test-Path $certPem)) {
        Write-Host "✗ SSL 证书生成失败（certutil 编码失败）"
        exit 1
    }
    # certutil 输出的 BEGIN TRUSTED CERTIFICATE 需要修正
    (Get-Content $certPem -Raw) -replace "TRUSTED CERTIFICATE", "CERTIFICATE" | Set-Content $CERT_FILE -NoNewline
}
else {
    Write-Host "✗ 未找到 certutil，无法导出 PEM"
    exit 1
}

Write-Host "✓ SSL 证书生成成功！"
Write-Host "  证书文件: $CERT_FILE"
Write-Host "  密钥文件: （.NET 方式不支持直接导出 PEM 私钥，请安装 openssl）"
exit 0
