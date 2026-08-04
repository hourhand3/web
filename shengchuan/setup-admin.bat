@echo off
echo ============================================
echo   声学数据传输系统 - 管理员设置 (仅需运行一次)
echo ============================================
echo.

echo [1/2] 添加 URL 保留 (允许手机访问)...
netsh http add urlacl url=http://+:8000/ user=Everyone
if %errorlevel% neq 0 (
    echo 错误: 需要管理员权限! 请右键此文件选择"以管理员身份运行"
    pause
    exit /b 1
)
echo 完成!
echo.

echo [2/2] 添加防火墙规则 (允许手机连接)...
netsh advfirewall firewall add rule name="AcousticDataTransfer" dir=in action=allow protocol=TCP localport=8000
if %errorlevel% neq 0 (
    echo 警告: 防火墙规则添加失败, 但服务器仍可运行
)
echo 完成!
echo.

echo ============================================
echo   设置完成! 现在可以运行 serve.ps1 启动服务器
echo ============================================
pause
