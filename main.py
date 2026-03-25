import json
import os
import socket
import sys
import threading
import time
import winreg

import eel

os.environ["GOOGLE_API_KEY"] = "no"
os.environ["GOOGLE_DEFAULT_CLIENT_ID"] = "no"
os.environ["GOOGLE_DEFAULT_CLIENT_SECRET"] = "no"

import backend.calculators
import backend.file_manager
import backend.gem_builds
import backend.gem_simulator
import backend.home
import backend.mod_manager
import backend.modder_tools
import backend.settings
import backend.star_chart
import backend.trovesaurus

if getattr(sys, 'frozen', False):
    base_dir = os.path.dirname(sys.executable)
    if not hasattr(sys, '_MEIPASS'):
        sys._MEIPASS = base_dir
    os.chdir(base_dir)
else:
    base_dir = os.path.dirname(os.path.abspath(__file__))

IPC_PORT = 28923

def register_btt_protocol():
    if sys.platform == 'win32':
        try:
            exe_path = sys.executable if getattr(sys, 'frozen', False) else os.path.abspath(sys.argv[0])
            
            key = winreg.CreateKey(winreg.HKEY_CURRENT_USER, r"Software\Classes\btt")
            winreg.SetValue(key, "", winreg.REG_SZ, "URL:btt Protocol")
            winreg.SetValueEx(key, "URL Protocol", 0, winreg.REG_SZ, "")
            
            cmd_key = winreg.CreateKey(key, r"shell\open\command")
            winreg.SetValue(cmd_key, "", winreg.REG_SZ, f'"{exe_path}" "%1"')
        except Exception as e:
            print(f"Failed to register protocol: {e}")

def check_single_instance_and_send_ipc():
    url = None
    for arg in sys.argv:
        if arg.startswith('btt://'):
            url = arg
            break

    try:
        # Try to connect to the IPC port. If successful, another instance is running.
        client = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        client.connect(('localhost', IPC_PORT))
        
        if url:
            client.sendall(url.encode('utf-8'))
            print("Link sent to existing instance. Exiting.")
        else:
            # Send a dummy payload to keep the socket alive just long enough to exit cleanly
            client.sendall(b"WAKE_UP") 
            print("Another instance is already running. Exiting.")
            
        client.close()
        sys.exit(0) # Exit because we are the second instance
    except ConnectionRefusedError:
        # Port is free, meaning we are the first instance!
        pass  
            
    return url

def start_ipc_server():
    def listen():
        server = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        server.bind(('localhost', IPC_PORT))
        server.listen(1)
        while True:
            conn, addr = server.accept()
            data = conn.recv(1024).decode('utf-8')
            if data and data.startswith('btt://'):
                eel.handle_deep_link(data)()
            # The server will ignore "WAKE_UP" or empty payloads naturally
            conn.close()
            
    threading.Thread(target=listen, daemon=True).start()

register_btt_protocol()
startup_url = check_single_instance_and_send_ipc()
start_ipc_server()

@eel.expose
def get_startup_url():
    return startup_url

@eel.expose
def get_app_metadata():
    meta_path = os.path.join(base_dir, "metadata.json")
    try:
        with open(meta_path, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return {}

chromium_path = os.path.join(base_dir, 'bin', 'chrome-win', 'chrome.exe')

print(f"Looking for Chromium at: {chromium_path}")
if not os.path.exists(chromium_path):
    print("❌ ERROR: Chromium .exe not found at the path above!")
    print("Please check your 'bin' folder and update the folder names in main.py.")
    sys.exit(1)
else:
    print("✅ Chromium found! Starting app...")

eel.browsers.set_path('chrome', chromium_path)

eel.init(os.path.join(base_dir, 'web'))

# Fallback logic: Try sequential ports if the primary one is busy
start_port = 28924
max_ports_to_try = 10

for current_port in range(start_port, start_port + max_ports_to_try):
    try:
        print(f"Attempting to launch UI on port {current_port}...")
        eel.start('index.html', mode='chrome', size=(1600, 1000), port=current_port, cmdline_args=[
            '--disable-infobars',
            '--no-default-browser-check',
            '--no-first-run',
            '--disable-background-mode',
            '--disable-dev-tools',
            '--disable-extensions',
            '--disable-sync',
            '--disable-translate',
        ])
        break  # UI closed normally, break out of the loop
    except OSError as e:
        print(f"⚠️ Port {current_port} is unavailable ({e}).")
        if current_port == start_port + max_ports_to_try - 1:
            print(f"❌ ERROR: Could not find an open port after {max_ports_to_try} attempts. Exiting cleanly.")
            sys.exit(1)
    except (SystemExit, MemoryError, KeyboardInterrupt):
        sys.exit(0)