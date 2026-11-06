"""Launch the exact desktop entry and own the GIO-created process."""

import os
from pathlib import Path
import select
import signal
import sys
import time

from gi.repository import Gio, GLib


def exited(pid, seconds):
    deadline = time.monotonic() + seconds
    while True:
        if os.waitpid(pid, os.WNOHANG)[0]:
            return True
        if time.monotonic() >= deadline:
            return False
        time.sleep(0.05)


def stop(pid):
    try:
        if exited(pid, 0):
            return True
        os.kill(pid, signal.SIGTERM)
        if exited(pid, 3):
            return True
        os.kill(pid, signal.SIGKILL)
        return exited(pid, 3)
    except OSError:
        return False


def main():
    if len(sys.argv) != 4:
        raise ValueError("Pass the desktop entry, installed executable and photo")
    entry, executable, photo = map(lambda value: Path(value).resolve(strict=True), sys.argv[1:])
    app = Gio.DesktopAppInfo.new_from_filename(str(entry))
    if app is None or Path(app.get_executable()).resolve() != executable:
        raise ValueError("The desktop entry does not target the expected application")
    if app.get_boolean("DBusActivatable"):
        raise ValueError("Expected a desktop entry that launches a child process")
    session = Path(os.environ["OPENLR_AGENT_FILE"])
    if session.exists() or session.parent != Path(os.environ["XDG_RUNTIME_DIR"]):
        raise ValueError("Expected a fresh private agent descriptor")
    children = []
    flags = GLib.SpawnFlags.DO_NOT_REAP_CHILD | GLib.SpawnFlags.STDOUT_TO_DEV_NULL
    try:
        ok = app.launch_uris_as_manager(
            [photo.as_uri()], None, flags, None, None, lambda _app, pid, *_: children.append(pid), None
        )
    except GLib.Error as error:
        print(error.message, file=sys.stderr)
        ok = False
    if not ok or len(children) != 1:
        print("GIO did not return one owned application process", file=sys.stderr)
        cleaned = [stop(pid) for pid in children]
        return 1 if cleaned and all(cleaned) else 2
    pid = children[0]
    try:
        print(pid, flush=True)
        while True:
            if exited(pid, 0):
                print("The application exited before shutdown was requested", file=sys.stderr)
                return 1
            readable, _, _ = select.select([sys.stdin], [], [], 0.1)
            if readable and not os.read(sys.stdin.fileno(), 1):
                return 0 if stop(pid) else 2
    except OSError as error:
        print(error, file=sys.stderr)
        return 1 if stop(pid) else 2


if __name__ == "__main__":
    sys.exit(main())
