# Server Start Guard

A simple add-on for opencode that stops your AI assistant from getting stuck when it starts a server.

## What it does

When the assistant starts a long running program like a server, this add-on quietly moves that program to run in the background. The assistant keeps working instead of waiting forever.

## How to install

1. Download this folder onto your computer.
2. Double click the file named `install.bat`.
3. Restart opencode.

You are done.

## How to remove

1. Delete this folder.
2. Remove the line about server start guard from the opencode settings file.
3. Restart opencode.

## One known issue

On Windows, a helper agent can stay stuck after it starts a server, even though the server itself runs fine. This is a problem in opencode on Windows, not in this add-on. The server keeps working while the helper agent is stuck.