import io
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from build_globe import download


class DownloadTest(unittest.TestCase):
    def test_incomplete_download_is_retried_and_complete_cache_is_reused(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "source.img"
            response = io.BytesIO(b"short")
            response.headers = {"Content-Length": "10"}
            with patch("urllib.request.urlopen", return_value=response):
                with self.assertRaises(OSError):
                    download("https://example.invalid/data", path)
            self.assertFalse(path.exists())
            self.assertFalse(path.with_name("source.img.part").exists())
            response = io.BytesIO(b"complete")
            response.headers = {"Content-Length": "8"}
            with patch("urllib.request.urlopen", return_value=response) as fetch:
                download("https://example.invalid/data", path)
                download("https://example.invalid/data", path)
                self.assertEqual(fetch.call_count, 1)
            self.assertEqual(path.read_bytes(), b"complete")


if __name__ == "__main__":
    unittest.main()
