import json
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


class VercelHostingTests(unittest.TestCase):
    def test_deployment_publishes_the_static_app_and_resolves_oauth_callback(self):
        config = json.loads((ROOT / "vercel.json").read_text(encoding="utf-8"))

        self.assertEqual(config["outputDirectory"], "static")
        self.assertEqual(config["redirects"], [{
            "source": "/",
            "destination": "/browser",
            "permanent": False,
        }])
        self.assertEqual(config["rewrites"], [{
            "source": "/browser",
            "destination": "/index.html",
        }])
        self.assertNotIn("functions", config)
        self.assertFalse((ROOT / "requirements.txt").exists())
        self.assertFalse((ROOT / "api" / "index.py").exists())
        self.assertTrue((ROOT / "static" / "index.html").is_file())
        self.assertTrue((ROOT / "static" / "favicon.svg").is_file())
        self.assertTrue((ROOT / "static" / "browser-client.mjs").is_file())
        self.assertTrue((ROOT / "static" / "dedupe-engine.mjs").is_file())


if __name__ == "__main__":
    unittest.main()
