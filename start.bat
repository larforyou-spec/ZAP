@echo off
echo ╔══════════════════════════════════════════════════════════════════════════════╗
echo ║  LARFORYOU ARENA - GAME LAUNCHER                                           ║
echo ╚══════════════════════════════════════════════════════════════════════════════╝
echo.
echo 🚀 Starting Larforyou Arena...
echo.

REM Check if Node.js is installed
node --version >nul 2>&1
if %errorlevel% neq 0 (
    echo ❌ Node.js is not installed. Please install Node.js first.
    echo 📥 Download from: https://nodejs.org/
    pause
    exit /b 1
)

REM Check if we're in the right directory
if not exist "package.json" (
    echo ❌ Please run this script from the project directory
    pause
    exit /b 1
)

REM Install dependencies if needed
if not exist "node_modules" (
    echo 📦 Installing dependencies...
    npm install
    if %errorlevel% neq 0 (
        echo ❌ Failed to install dependencies
        pause
        exit /b 1
    )
)

echo 🎮 Starting game server...
echo.
echo 🌐 Game will be available at: http://localhost:3000
echo 🔗 API will be available at: http://localhost:3000/api
echo.
echo ⚠️  Press Ctrl+C to stop the server
echo.

REM Start the server
npm start

pause
