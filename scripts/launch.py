"""Start Quest Maker on its usual origin and open the default browser."""

import argparse
import errno
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
import threading
from urllib.error import URLError
from urllib.request import ProxyHandler, build_opener
import webbrowser


WEB_ROOT = Path(__file__).resolve().parents[1] / "web"
HOST, PORT = "127.0.0.1", 4173
URL = f"http://{HOST}:{PORT}/"


class QuestHandler(SimpleHTTPRequestHandler):
    extensions_map = {
        **SimpleHTTPRequestHandler.extensions_map,
        ".js": "text/javascript",
        ".webmanifest": "application/manifest+json",
    }


def is_quest_server():
    """Reuse an existing Quest server, without opening another app on this port."""
    try:
        # Local requests should go directly to this machine, even with a proxy set.
        opener = build_opener(ProxyHandler({}))
        with opener.open(URL + "manifest.webmanifest", timeout=2) as response:
            manifest = json.loads(response.read(32_768))
        return isinstance(manifest, dict) and manifest.get("short_name") == "Quest Maker"
    except (URLError, OSError, ValueError):
        return False


def open_browser():
    try:
        if webbrowser.open(URL, new=2):
            return
    except (webbrowser.Error, OSError):
        pass
    print(f"브라우저에서 이 주소를 열어주세요: {URL}", flush=True)


def main():
    parser = argparse.ArgumentParser(description="Quest Maker 로컬 실행")
    parser.add_argument("--no-browser", action="store_true", help="브라우저를 열지 않고 서버만 실행")
    args = parser.parse_args()

    if not (WEB_ROOT / "index.html").is_file():
        print("앱 파일을 찾지 못했어요. 실행 파일을 quest 폴더 안에 두고 열어주세요.")
        return 1

    try:
        server = ThreadingHTTPServer((HOST, PORT), partial(QuestHandler, directory=str(WEB_ROOT)))
    except OSError as error:
        if error.errno == errno.EADDRINUSE:
            if is_quest_server():
                print(f"Quest Maker가 이미 실행 중이에요. {URL}", flush=True)
                if not args.no_browser:
                    open_browser()
                print("이 창은 닫아도 괜찮아요. 기존 서버 창은 그대로 두세요.")
                return 0
            print("4173번 포트를 다른 프로그램이 사용하고 있어요.")
            print("기존 프로그램을 확인한 뒤 다시 열어주세요. 다른 포트로 자동 변경하지는 않아요.")
            print("같은 주소를 유지해야 기존 퀘스트 기록을 계속 볼 수 있어요.")
        else:
            print(f"서버를 시작하지 못했어요: {error}")
        return 1

    print(f"Quest Maker를 열고 있어요. {URL}", flush=True)
    print("사용하는 동안 이 창을 켜두세요. 종료하려면 Ctrl+C를 누르면 돼요.", flush=True)
    if not args.no_browser:
        # Serve requests while the operating system starts the browser.
        threading.Thread(target=open_browser, daemon=True).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
    print("\nQuest Maker 서버를 종료했어요. 저장된 기록은 그대로 보관돼요.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
