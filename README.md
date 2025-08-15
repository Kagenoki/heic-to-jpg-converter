# HEIC → JPG Converter – Installation and Usage Guide

This guide explains how to run the **`heic_to_jpg_converter.js`** script on **Windows** and **Debian/Ubuntu**.

---

## Requirements

The script requires **Node.js ≥ 18** and some external tools (not all are mandatory):

* `exiftool` → for metadata preservation (recommended)
* `magick` or `convert` (ImageMagick) → preferred still image converter
* `ffmpeg` and `ffprobe` → for motion video extraction
* Optional: `heif-convert` (from `libheif`)

The script automatically detects which tools are available and chooses the best available conversion path.

---

## 1. Windows

### 1.1 Install Node.js

**Option A – Manual:**

1. Download Node.js LTS from [nodejs.org](https://nodejs.org/).
2. Install with default options.

**Option B – With Chocolatey:**

```powershell
choco install nodejs-lts
```

### 1.2 Install External Tools

**Option A – Manual:**

* **ImageMagick**: [Download](https://imagemagick.org/script/download.php#windows) → during installation, enable **"Install legacy utilities (e.g., convert)"**.
* **ExifTool**: [Download ZIP](https://exiftool.org/) → extract → rename `exiftool(-k).exe` to `exiftool.exe` → add folder to `PATH`.
* **FFmpeg + FFprobe**: [Download](https://www.gyan.dev/ffmpeg/builds/) → extract → add `bin` folder to `PATH`.

**Option B – With Chocolatey:**

```powershell
choco install imagemagick ffmpeg exiftool
```

### 1.3 Run the Script

```powershell
cd <path_to_script>
node .\heic_to_jpg_converter.js <input_dir> <output_dir> --debug
```

Example:

```powershell
node .\heic_to_jpg_converter.js .\input\ .\output\ --quality 90
```

---

## 2. Debian / Ubuntu

### 2.1 Install Node.js

```bash
sudo apt update
sudo apt install -y curl
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs
```

### 2.2 Install External Tools

```bash
sudo apt install -y imagemagick exiftool ffmpeg libheif-examples
```

### 2.3 Run the Script

```bash
cd /path/to/script
node heic_to_jpg_converter.js /path/to/input /path/to/output --debug
```

Example:

```bash
node heic_to_jpg_converter.js ./input ./output --quality 90
```

---

## 3. Useful Options

* `--quality <1-100>` → JPEG quality (default: 95)
* `--debug` → verbose logging
* `--recursive` → process subfolders
* `--dry-run` → show plan without writing files

---

✅ **Tip:** For best results, install **ExifTool** and **ImageMagick** to ensure full metadata preservation and correct image orientation.
