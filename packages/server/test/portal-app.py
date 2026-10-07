"""Test only: a thread's web server for portal-test.ts, run with `cube
service start`. GET / answers a page and a cookie with a Domain, /headers
echoes the request head, /weird has a control character in its
reason phrase, /big streams 64 MiB, and a WebSocket upgrade is
answered with 101 and then echoes bytes."""
import os
import socket
import threading

server = socket.socket()
server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
server.bind(("127.0.0.1", int(os.environ["PORT"])))
server.listen(64)
closed_big = os.path.join(os.environ.get("CUBE_APP_STATE", "."), "big-closed")


def serve(connection):
    data = b""
    while b"\r\n\r\n" not in data:
        chunk = connection.recv(4096)
        if not chunk:
            connection.close()
            return
        data += chunk
    head, _, rest = data.partition(b"\r\n\r\n")
    path = head.split(b" ")[1]
    try:
        if b"\r\nupgrade: websocket" in head.lower():
            connection.sendall(b"HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n" + rest)
            while True:
                chunk = connection.recv(65536)
                if not chunk:
                    break
                connection.sendall(chunk)
        elif path == b"/weird":
            # A reason phrase Node refuses to send on.
            connection.sendall(b"HTTP/1.1 200 \x01Weird\r\ncontent-length: 2\r\n\r\nok")
        elif path == b"/big":
            connection.sendall(b"HTTP/1.1 200 OK\r\ncontent-length: %d\r\n\r\n" % (64 << 20))
            try:
                for _ in range(1024):
                    connection.sendall(b"x" * 65536)
            except OSError:
                open(closed_big, "w").close()
        else:
            body = head if path == b"/headers" else b"hello from the service, " + os.environ.get("HOST", "").encode()
            connection.sendall(b"HTTP/1.1 200 OK\r\ncontent-type: text/plain\r\nset-cookie: session=1; Domain=sslip.io; Path=/\r\n"
                               b"content-length: %d\r\n\r\n" % len(body) + body)
    except OSError:
        pass
    connection.close()


while True:
    client, _ = server.accept()
    threading.Thread(target=serve, args=(client,), daemon=True).start()
