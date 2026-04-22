## Run locally

From the project root:

```bash
python3 -m venv venv
source venv/bin/activate
pip install -r requirements.txt
python3 server.py
```

Then open [http://localhost:8000](http://localhost:8000).

Paste a game boxscore URL (with play-by-play) into the input at the top of the page and click **Load game**. The visualizations stay hidden until a URL is loaded successfully.
