# Flight-Log-Analyser

![Python](https://img.shields.io/badge/Python-3.8%2B-blue) ![Flask](https://img.shields.io/badge/Flask-2.0%2B-green) ![Bootstrap](https://img.shields.io/badge/Bootstrap-5.3-blueviolet) ![License](https://img.shields.io/badge/License-MIT-yellow)

The **Flight Log Analyser** is a web-based application designed to upload, process, and visualize Ardupilot flight logs (`.BIN`,`.log` files), along with associated flight test documentation (Markdown `.md` files) and videos. Built with Flask, it provides an intuitive interface for drone enthusiasts and engineers to analyze flight performance metrics such as attitude, rate, altitude, ESC (Electronic Speed Controller) data, and battery status. The application supports GitHub OAuth for secure user authentication and stores session data in a SQLite database.

## Features

- **Secure Authentication**: Login via GitHub OAuth to ensure secure access to your flight data.
- **File Uploads**:
  - Upload Ardupilot `.BIN` or `.log` log files for flight data analysis.
  - Upload Markdown (`.md`) files to document flight test processes.
  - Upload multiple video files to associate with flight sessions.
- **Flight Data Visualization**: Automatically generates plots for:
  - **Attitude**: Roll, Pitch, Yaw (actual vs. desired).
  - **Rate**: Angular rates (R, P, Y) and their desired values.
  - **Altitude**: Altitude data from barometer sensors.
  - **ESC Data**: RPM, Voltage, Current, and Temperature for up to four ESCs.
  - **Battery**: Voltage, Current, and Temperature over time.
  - Additional plots for GPS accuracy (GPA), vibration (VIBE), RC input/output (RCIN/RCOU), and EKF data (XKF4).
- **Progress Tracking**: Real-time progress bar during file uploads and processing.
- **Session Management**: View and revisit past upload sessions with associated files and visualizations.
- **Responsive Interface**: Built with Bootstrap 5.3 for a clean, mobile-friendly experience.
- **Markdown Rendering**: Displays flight test documentation with support for fenced code blocks and tables.

## Installation

### Prerequisites

- Python 3.8+
- Git
- SQLite (included with Python)
- A GitHub account for OAuth setup

### Steps

1. **Clone the Repository**:
   ```bash
   git clone https://github.com/Pan-Robotics/Flight-Log-Analyser.git
   cd Flight-Log-Analyser
   ```

2. **Create a Virtual Environment**:
   ```bash
   python -m venv venv
   source venv/bin/activate  # On Windows: venv\Scripts\activate
   ```

3. **Install Dependencies**:
   ```bash
   pip install -r requirements.txt
   ```

   Example `requirements.txt`:
   ```
    matplotlib==3.5.2
    authlib==1.0.1
    flask-login==0.5.0
    python-dotenv==0.20.0
    flask==1.1.2
    werkzeug==1.0.1
    Jjinja2==3.0.3
    itsdangerous==1.1.0
    pymavlink==2.4.31
    markdown==3.8
    requests==3.32.3
   ```

4. **Set Up Environment Variables**:
   Create a `.env` file in the project root:
   ```env
   FLASK_SECRET_KEY=your-secret-key
   GITHUB_CLIENT_ID=your-github-client-id
   GITHUB_CLIENT_SECRET=your-github-client-secret
   ```

   Obtain `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET` by registering an OAuth application on GitHub:
   - Go to GitHub > Settings > Developer settings > OAuth Apps > New OAuth App.
   - Set the callback URL to `http://localhost:5000/authorize` for local development.
   - Set the Homepage URL to `https://www.arrowair.com` for local development.(doesn't really matter)
   
  Obtain `FLASK_SECRET_KEY` via the terminal by:
  ```bash
  head -c32 /dev/urandom | xxd -p -c32
  ```

5. **Initialize the Database**:
   The application automatically creates a SQLite database (`users.db`) on first run.

6. **Run the Application**:
   ```bash
   python LogAnalyserApp.py
   ```

   The app will be available at `http://localhost:5000`.
   
   - if Port 5000 was already in use on your machine. it can be changed it to say 5050 in the main python code
   
   so The app will be available at `http://localhost:5050`.

## Usage

1. **Login**: Access the app and log in using your GitHub account.
2. **Upload Files**:
   - Select an Ardupilot `.BIN` or `.log` log file.
   - Optionally upload a Markdown `.md` file for test documentation.
   - Optionally upload one or more video files.
3. **Monitor Progress**: A progress bar tracks file uploads and processing.
4. **View Results**:
   - Navigate tabs to view generated plots (Attitude, Rate, Altitude, ESC, Battery, etc.).
   - Review rendered Markdown content under the "Markdown" tab.
   - Access uploaded videos via links in the "Videos" tab.
5. **Manage Sessions**: Revisit past sessions from the upload page to view previously analyzed data.
6. **Logout**: Securely log out when done.
7. **Anonymize**: choose whether or not to generate a `.log` file with GPS tracking data and output a new `.log` file.

## Project Structure

```
flight-log-analyzer/
├── static/
│   └── plots/              # Generated plot images
├── templates/
│   ├── upload.html         # File upload interface
│   ├── results.html        # Analysis results and visualizations
│   └── logout_confirmation.html  # Logout confirmation page
├── uploads/                # Uploaded files (logs, markdown, videos)
├── LogAnalyserApp.py       # Main Flask application
├── requirements.txt        # Python dependencies
├── .env                    # Environment variables
└── README.md               # This file
```

## Contributing

Contributions are welcome! Please follow these steps:

1. Fork the repository.
2. Create a feature branch (`git checkout -b feature/your-feature`).
3. Commit your changes (`git commit -m "Add your feature"`).
4. Push to the branch (`git push origin feature/your-feature`).
5. Open a Pull Request.

## License

This project is licensed under the MIT License. See the [LICENSE](LICENSE) file for details.

## Contact

For issues or questions, open an issue on this repository or contact [info@panrobotics.xyz].

---

Happy analyzing! 🚁
