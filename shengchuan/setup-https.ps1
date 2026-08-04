# HTTPS 设置脚本 (需要管理员权限)
Write-Host "=== Setting up HTTPS ==="

# 1. 创建自签名证书
Write-Host "Creating self-signed certificate..."
$cert = New-SelfSignedCertificate -DnsName "192.168.110.195","localhost" -CertStoreLocation "cert:\LocalMachine\My" -FriendlyName "AcousticDataTransfer" -NotAfter (Get-Date).AddYears(1) -KeyUsage DigitalSignature,KeyEncipherment -KeyAlgorithm RSA -KeyLength 2048
$thumbprint = $cert.Thumbprint
Write-Host "Certificate created: $thumbprint"

# 2. 添加 SSL 证书绑定
Write-Host "Binding certificate to port 8443..."
netsh http add sslcert ipport=0.0.0.0:8443 certhash=$thumbprint appid="{a1b2c3d4-e5f6-7890-abcd-ef1234567890}"

# 3. 添加 URL ACL
Write-Host "Adding URL ACL..."
netsh http add urlacl url=https://+:8443/ user=Everyone

# 4. 添加防火墙规则
Write-Host "Adding firewall rule..."
netsh advfirewall firewall add rule name="AcousticDataTransfer-HTTPS" dir=in action=allow protocol=TCP localport=8443

Write-Host "=== HTTPS setup complete! ==="
Write-Host "Phone access: https://192.168.110.195:8443/"
Start-Sleep -Seconds 3
