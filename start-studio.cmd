@echo off
setlocal

set "ROOT=%~dp0"
set "IMAGE_STUDIO_OUTPUT_DIR=%ROOT%output"
set "IMAGE_STUDIO_LOCAL_DATA_DIR=%ROOT%.local"
set "OPENAI_API_KEY=your_api_key_here"
set "OPENAI_BASE_URL=https://api.openai.com/v1"
set "RESPONSES_MODEL=gpt-5.4"
if not "%PORT%"=="" goto run
set "PORT=3600"
:run

echo Starting GPT-Image2-Studio on http://localhost:%PORT%
echo Output dir: %IMAGE_STUDIO_OUTPUT_DIR%
node "%ROOT%server.mjs"

endlocal
