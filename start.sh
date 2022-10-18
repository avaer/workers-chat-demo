#!/bin/bash
# use sed to replace the line starting with "command2 = isWsl" in the file
# this is needed to fix looking for the wrong powershell.exe on non-C:\ drives
sed -i 's/command2 = isWsl.*/command2 = "powershell.exe"/' ./node_modules/wrangler/wrangler-dist/cli.js

# start local development server
node ./node_modules/wrangler dev -l
