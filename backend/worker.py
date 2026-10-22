import json
import os
import socket
import sys
import threading
import uvicorn
from app import create_app

if __name__ == '__main__':
    # 凭据经stdin传递，不出现在命令行或磁盘配置中。
    config = json.loads(sys.stdin.readline())
    app = create_app(config['directory'], config['token'])
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    sock.bind(('127.0.0.1', 0))
    sock.listen(128)
    server = uvicorn.Server(uvicorn.Config(app, log_level='error', access_log=False))

    def watch_parent():
        # 父进程正常退出或崩溃都会关闭管道；异常退出后也不留下孤立服务。
        try:
            sys.stdin.read()
        finally:
            server.should_exit = True

    threading.Thread(target=watch_parent, daemon=True).start()
    print(json.dumps({'port': sock.getsockname()[1]}), flush=True)
    server.run(sockets=[sock])
