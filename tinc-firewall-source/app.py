from flask import Flask, jsonify, request, render_template_string
import subprocess

app = Flask(__name__)

def run_ufw(args):
    try:
        r = subprocess.run(["ufw"] + args, capture_output=True, text=True)
        return r.stdout.strip() or r.stderr.strip()
    except Exception as e:
        return str(e)

HTML = """
<!DOCTYPE html>
<html><head><title>Tinc Firewall</title><style>body{font-family:sans-serif;padding:20px;} button{margin:5px;padding:10px;cursor:pointer;} pre{background:#eee;padding:10px;}</style></head>
<body>
    <h2>Tinc Firewall (UFW)</h2>
    <button onclick="cmd(['status', 'numbered'])">Durum Görüntüle</button>
    <button onclick="cmd(['enable'])">Firewall Aç (Enable)</button>
    <button onclick="cmd(['disable'])">Firewall Kapat (Disable)</button>
    <hr>
    <input type="text" id="port" placeholder="Port (Örn: 9010)">
    <button onclick="cmd(['allow', document.getElementById('port').value])">Port Aç</button>
    <button onclick="cmd(['deny', document.getElementById('port').value])">Port Kapat</button>
    <pre id="out"></pre>
    <script>
        async function cmd(args) {
            const r = await fetch('/api/run', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({args})});
            document.getElementById('out').innerText = (await r.json()).output;
        }
    </script>
</body></html>
"""

@app.route("/")
def index():
    return render_template_string(HTML)

@app.route("/api/run", methods=["POST"])
def api_run():
    args = request.json.get("args", [])
    out = run_ufw(args)
    return jsonify({"output": out})

if __name__ == "__main__":
    app.run(host="0.0.0.0", port=9013)
