#!/usr/bin/env python3
import os
import matplotlib
import markdown
from datetime import datetime
matplotlib.use('Agg')
import matplotlib.pyplot as plt
from pymavlink import mavutil
from flask import Flask, request, render_template, send_from_directory, redirect, url_for, session
from flask_login import LoginManager, UserMixin, login_user, logout_user, login_required, current_user
from authlib.integrations.flask_client import OAuth
import sqlite3
import shutil
from werkzeug.security import generate_password_hash, check_password_hash
from dotenv import load_dotenv
load_dotenv()

app = Flask(__name__)
app.secret_key = os.environ.get('FLASK_SECRET_KEY', 'your-secret-key')  # Set in environment for production

# Flask-Login setup
login_manager = LoginManager()
login_manager.init_app(app)
login_manager.login_view = 'login'

# OAuth setup
oauth = OAuth(app)
github = oauth.register(
    name='github',
    client_id=os.environ.get('GITHUB_CLIENT_ID'),
    client_secret=os.environ.get('GITHUB_CLIENT_SECRET'),
    access_token_url='https://github.com/login/oauth/access_token',
    access_token_params=None,
    authorize_url='https://github.com/login/oauth/authorize',
    authorize_params={'prompt': 'login'},  # Force reauthentication
    api_base_url='https://api.github.com/',
    client_kwargs={'scope': 'user:email'},
)

# Directories
UPLOAD_FOLDER = 'uploads'
PLOT_FOLDER = 'static/plots'
app.config['UPLOAD_FOLDER'] = UPLOAD_FOLDER
app.config['PLOT_FOLDER'] = PLOT_FOLDER
os.makedirs(UPLOAD_FOLDER, exist_ok=True)
os.makedirs(PLOT_FOLDER, exist_ok=True)

# Database setup
DATABASE = 'users.db'

def init_db():
    with sqlite3.connect(DATABASE) as conn:
        c = conn.cursor()
        c.execute('''CREATE TABLE IF NOT EXISTS users
                     (id INTEGER PRIMARY KEY AUTOINCREMENT,
                      github_id TEXT UNIQUE,
                      username TEXT)''')
        c.execute('''CREATE TABLE IF NOT EXISTS sessions
                     (id INTEGER PRIMARY KEY AUTOINCREMENT,
                      user_id INTEGER,
                      log_file TEXT,
                      markdown_file TEXT,
                      videos TEXT,
                      created_at TIMESTAMP,
                      FOREIGN KEY (user_id) REFERENCES users(id))''')
        conn.commit()

init_db()

# User model for Flask-Login
class User(UserMixin):
    def __init__(self, id, github_id, username):
        self.id = id
        self.github_id = github_id
        self.username = username

@login_manager.user_loader
def load_user(user_id):
    with sqlite3.connect(DATABASE) as conn:
        c = conn.cursor()
        c.execute('SELECT id, github_id, username FROM users WHERE id = ?', (user_id,))
        user = c.fetchone()
        if user:
            return User(user[0], user[1], user[2])
        return None

# Utility functions (unchanged)
def get_time_from_msg(msg):
    if hasattr(msg, 'time_boot_ms'):
        return msg.time_boot_ms / 1000.0
    if hasattr(msg, 'TimeUS'):
        return msg.TimeUS / 1e6
    return None

def parse_log(logfile):
    # Check file extension to determine parsing method
    if logfile.endswith('.BIN'):
        mav = mavutil.mavlink_connection(logfile, robust_parsing=True, dialect='ardupilotmega')
    elif logfile.endswith('.log'):
        mav = mavutil.mavlink_connection(logfile, robust_parsing=True, dialect='ardupilotmega')  # Adjust if needed for .log files
    else:
        raise ValueError("Unsupported file format")
    
    # Initialize data structures
    attitude_data = {'Time': [], 'Roll': [], 'Pitch': [], 'Yaw': [], 'DesRoll': [], 'DesPitch': [], 'DesYaw': []}
    RATE_data = {'Time': [], 'R': [], 'P': [], 'Y': [], 'RDes': [], 'PDes': [], 'YDes': []}
    altitude_data = {'Time0': [], 'Time1': [], 'Alt0': [], 'Alt1': []}
    ESC_data = {i: {'Time': [], 'RPM': [], 'RawRPM': [], 'Voltage': [], 'Current': [], 'Temp': []} for i in range(4)}
    BAT_data = {'Time': [], 'Volt': [], 'Curr': [], 'Temp': []}
    GPA_data = {'Time': [], 'HAcc': [], 'SAcc': [], 'VAcc': []}
    VIBE_data = {'Time': [], 'VibeX': [], 'VibeY': [], 'VibeZ': [], 'Clip': []}
    RCIN_data = {'Time': [], 'C1': [], 'C2': [], 'C3': [], 'C4': []}
    RCOU_data = {'Time': [], 'C1': [], 'C2': [], 'C3': [], 'C4': []}
    XKF4_data = {'Time': [], 'SV': [], 'SP': [], 'SH': [], 'SM': [], 'SVT': []}

    # Parse the log file
    while True:
        msg = mav.recv_match(blocking=True)
        if msg is None:
            break
        t = get_time_from_msg(msg) or (mav.time if hasattr(mav, 'time') else None)
        if t is None:
            continue

        msg_type = msg.get_type()
        dataDict = msg.to_dict()

        if msg_type == "ATT":
            attitude_data['Time'].append(t)
            attitude_data['Roll'].append(dataDict['Roll'])
            attitude_data['Pitch'].append(dataDict['Pitch'])
            attitude_data['Yaw'].append(dataDict['Yaw'])
            attitude_data['DesRoll'].append(dataDict['DesRoll'])
            attitude_data['DesPitch'].append(dataDict['DesPitch'])
            attitude_data['DesYaw'].append(dataDict['DesYaw'])
        elif msg_type == "RATE":
            RATE_data['Time'].append(t)
            RATE_data['R'].append(dataDict['R'])
            RATE_data['P'].append(dataDict['P'])
            RATE_data['Y'].append(dataDict['Y'])
            RATE_data['RDes'].append(dataDict['RDes'])
            RATE_data['PDes'].append(dataDict['PDes'])
            RATE_data['YDes'].append(dataDict['YDes'])
        elif msg_type == "XKF4":
            XKF4_data['Time'].append(t)
            XKF4_data['SV'].append(dataDict['SV'])
            XKF4_data['SP'].append(dataDict['SP'])
            XKF4_data['SH'].append(dataDict['SH'])
            XKF4_data['SM'].append(dataDict['SM'])
            XKF4_data['SVT'].append(dataDict['SVT'])
        elif msg_type == "BARO" and dataDict['I'] in [0, 1]:
            if hasattr(msg, 'Alt'):
                key = 'Time0' if dataDict['I'] == 0 else 'Time1'
                alt_key = 'Alt0' if dataDict['I'] == 0 else 'Alt1'
                altitude_data[key].append(t)
                altitude_data[alt_key].append(msg.Alt)
        elif msg_type == "GPA":
            GPA_data['Time'].append(t)
            GPA_data['HAcc'].append(dataDict['HAcc'])
            GPA_data['SAcc'].append(dataDict['SAcc'])
            GPA_data['VAcc'].append(dataDict['VAcc'])
        elif msg_type == "VIBE":
            VIBE_data['Time'].append(t)
            VIBE_data['VibeX'].append(dataDict['VibeX'])
            VIBE_data['VibeY'].append(dataDict['VibeY'])
            VIBE_data['VibeZ'].append(dataDict['VibeZ'])
            VIBE_data['Clip'].append(dataDict['Clip'])
        elif msg_type == "ESC" and dataDict['Instance'] in ESC_data:
            instance = dataDict['Instance']
            ESC_data[instance]['Time'].append(t)
            ESC_data[instance]['RPM'].append(msg.RPM)
            ESC_data[instance]['RawRPM'].append(msg.RawRPM)
            ESC_data[instance]['Voltage'].append(msg.Volt)
            ESC_data[instance]['Current'].append(msg.Curr)
            ESC_data[instance]['Temp'].append(msg.Temp)
        elif msg_type == "BAT":
            BAT_data['Time'].append(t)
            BAT_data['Volt'].append(msg.Volt)
            BAT_data['Curr'].append(msg.Curr)
            BAT_data['Temp'].append(msg.Temp)
        elif msg_type == "RCIN":
            RCIN_data['Time'].append(t)
            RCIN_data['C1'].append(msg.C1)
            RCIN_data['C2'].append(msg.C2)
            RCIN_data['C3'].append(msg.C3)
            RCIN_data['C4'].append(msg.C4)
        elif msg_type == "RCOU":
            RCOU_data['Time'].append(t)
            RCOU_data['C1'].append(msg.C1)
            RCOU_data['C2'].append(msg.C2)
            RCOU_data['C3'].append(msg.C3)
            RCOU_data['C4'].append(msg.C4)

    return attitude_data, RATE_data, altitude_data, ESC_data, BAT_data, GPA_data, VIBE_data, RCIN_data, RCOU_data, XKF4_data

def generate_plots(attitude_data, RATE_data, altitude_data, ESC_data, BAT_data, GPA_data, VIBE_data, RCIN_data, RCOU_data, XKF4_data, plot_dir):
    plot_files = {}
    if os.path.exists(plot_dir):
        shutil.rmtree(plot_dir)
    os.makedirs(plot_dir)

    # Attitude Plot
    plt.figure(figsize=(12, 12))
    plt.subplot(3, 1, 1)
    plt.plot(attitude_data['Time'], attitude_data['Roll'], label='Roll', color='red')
    plt.plot(attitude_data['Time'], attitude_data['DesRoll'], label='DesRoll', color='black', linestyle='--')
    plt.xlabel("Time (s)")
    plt.ylabel("Roll (Degrees)")
    plt.title("Roll and DesRoll vs Time")
    plt.legend()
    plt.grid()

    plt.subplot(3, 1, 2)
    plt.plot(attitude_data['Time'], attitude_data['Pitch'], label='Pitch', color='green')
    plt.plot(attitude_data['Time'], attitude_data['DesPitch'], label='DesPitch', color='blue', linestyle='--')
    plt.xlabel("Time (s)")
    plt.ylabel("Pitch (Degrees)")
    plt.title("Pitch and DesPitch vs Time")
    plt.legend()
    plt.grid()

    plt.subplot(3, 1, 3)
    plt.plot(attitude_data['Time'], attitude_data['Yaw'], label='Yaw', color='orange')
    plt.plot(attitude_data['Time'], attitude_data['DesYaw'], label='DesYaw', color='black', linestyle='--')
    plt.xlabel("Time (s)")
    plt.ylabel("Yaw (Degrees)")
    plt.title("Yaw and DesYaw vs Time")
    plt.legend()
    plt.grid()

    plt.tight_layout()
    plot_files['attitude'] = os.path.join(plot_dir, 'attitude.png')
    plt.savefig(plot_files['attitude'])
    plt.close()

    # Rate Plot
    plt.figure(figsize=(12, 12))
    plt.subplot(3, 1, 1)
    plt.plot(RATE_data['Time'], RATE_data['R'], label='R', color='red')
    plt.plot(RATE_data['Time'], RATE_data['RDes'], label='RDes', color='purple', linestyle='--')
    plt.xlabel("Time (s)")
    plt.ylabel("R (Degrees/s)")
    plt.title("R and RDes vs Time")
    plt.legend()
    plt.grid()

    plt.subplot(3, 1, 2)
    plt.plot(RATE_data['Time'], RATE_data['P'], label='P', color='green')
    plt.plot(RATE_data['Time'], RATE_data['PDes'], label='PDes', color='blue', linestyle='--')
    plt.xlabel("Time (s)")
    plt.ylabel("P (Degrees/s)")
    plt.title("P and PDes vs Time")
    plt.legend()
    plt.grid()

    plt.subplot(3, 1, 3)
    plt.plot(RATE_data['Time'], RATE_data['Y'], label='Y', color='orange')
    plt.plot(RATE_data['Time'], RATE_data['YDes'], label='YDes', color='black', linestyle='--')
    plt.xlabel("Time (s)")
    plt.ylabel("Y (Degrees/s)")
    plt.title("Y and YDes vs Time")
    plt.legend()
    plt.grid()

    plt.tight_layout()
    plot_files['rate'] = os.path.join(plot_dir, 'rate.png')
    plt.savefig(plot_files['rate'])
    plt.close()

    # Altitude Plot
    plt.figure(figsize=(12, 10))
    if altitude_data['Time0'] or altitude_data['Time1']:
        plt.plot(altitude_data['Time0'], altitude_data['Alt0'], label='Altitude0', color='black')
        plt.plot(altitude_data['Time1'], altitude_data['Alt1'], label='Altitude1', color='purple')
        plt.xlabel("Time (s)")
        plt.ylabel("Altitude (m)")
        plt.title("Altitude vs Time")
        plt.legend()
        plt.grid()
    plt.tight_layout()
    plot_files['altitude'] = os.path.join(plot_dir, 'altitude.png')
    plt.savefig(plot_files['altitude'])
    plt.close()

    # ESC Plots
    for instance, data in ESC_data.items():
        plt.figure(figsize=(12, 12))
        keys = ['RPM', 'RawRPM', 'Voltage', 'Current', 'Temp']
        for i, key in enumerate(keys, start=1):
            if data['Time']:
                plt.subplot(len(keys), 1, i)
                plt.plot(data['Time'], data[key], label=key, color='C' + str(i))
                plt.xlabel("Time (s)")
                plt.ylabel(key)
                plt.title(f"ESC{instance} {key} vs Time")
                plt.legend()
                plt.grid()
        plt.tight_layout()
        plot_files[f'esc_{instance}'] = os.path.join(plot_dir, f'esc_{instance}.png')
        plt.savefig(plot_files[f'esc_{instance}'])
        plt.close()

    # Battery Plot
    if BAT_data['Time']:
        plt.figure(figsize=(10, 8))
        plt.subplot(3, 1, 1)
        plt.plot(BAT_data['Time'], BAT_data['Volt'], label='Voltage', color='blue')
        plt.xlabel("Time (s)")
        plt.ylabel("Voltage (V)")
        plt.title("Battery Voltage vs Time")
        plt.legend()
        plt.grid()
        plt.subplot(3, 1, 2)
        plt.plot(BAT_data['Time'], BAT_data['Curr'], label='Current', color='green')
        plt.xlabel("Time (s)")
        plt.ylabel("Current (A)")
        plt.title("Battery Current vs Time")
        plt.legend()
        plt.grid()
        plt.subplot(3, 1, 3)
        plt.plot(BAT_data['Time'], BAT_data['Temp'], label='Temperature', color='red')
        plt.xlabel("Time (s)")
        plt.ylabel("Temperature (°C)")
        plt.title("Battery Temperature vs Time")
        plt.legend()
        plt.grid()
        plt.tight_layout()
        plot_files['battery'] = os.path.join(plot_dir, 'battery.png')
        plt.savefig(plot_files['battery'])
        plt.close()

    # GPA Plot
    if GPA_data['Time']:
        plt.figure(figsize=(10, 6))
        plt.plot(GPA_data['Time'], GPA_data['HAcc'], label='HAcc', color='blue')
        plt.plot(GPA_data['Time'], GPA_data['SAcc'], label='SAcc', color='green')
        plt.plot(GPA_data['Time'], GPA_data['VAcc'], label='VAcc', color='red')
        plt.xlabel("Time (s)")
        plt.ylabel("Accuracy")
        plt.title("GPA Data vs Time")
        plt.legend()
        plt.grid()
        plt.tight_layout()
        plot_files['gpa'] = os.path.join(plot_dir, 'gpa.png')
        plt.savefig(plot_files['gpa'])
        plt.close()

    # VIBE Plot
    if VIBE_data['Time']:
        plt.figure(figsize=(10, 6))
        plt.plot(VIBE_data['Time'], VIBE_data['VibeX'], label='VibeX', color='blue')
        plt.plot(VIBE_data['Time'], VIBE_data['VibeY'], label='VibeY', color='green')
        plt.plot(VIBE_data['Time'], VIBE_data['VibeZ'], label='VibeZ', color='red')
        plt.plot(VIBE_data['Time'], VIBE_data['Clip'], label='Clip', color='purple')
        plt.xlabel("Time (s)")
        plt.ylabel("Vibration")
        plt.title("VIBE Data vs Time")
        plt.legend()
        plt.grid()
        plt.tight_layout()
        plot_files['vibe'] = os.path.join(plot_dir, 'vibe.png')
        plt.savefig(plot_files['vibe'])
        plt.close()

    # RCIN Plot
    if RCIN_data['Time']:
        plt.figure(figsize=(10, 6))
        for i in range(1, 5):
            plt.plot(RCIN_data['Time'], RCIN_data[f'C{i}'], label=f'C{i}')
        plt.xlabel("Time (s)")
        plt.ylabel("RCIN Channels")
        plt.title("RCIN Data vs Time")
        plt.legend()
        plt.grid()
        plt.tight_layout()
        plot_files['rcin'] = os.path.join(plot_dir, 'rcin.png')
        plt.savefig(plot_files['rcin'])
        plt.close()

    # RCOU Plot
    if RCOU_data['Time']:
        plt.figure(figsize=(10, 6))
        for i in range(1, 5):
            plt.plot(RCOU_data['Time'], RCOU_data[f'C{i}'], label=f'C{i}')
        plt.xlabel("Time (s)")
        plt.ylabel("RCOU Channels")
        plt.title("RCOU Data vs Time")
        plt.legend()
        plt.grid()
        plt.tight_layout()
        plot_files['rcou'] = os.path.join(plot_dir, 'rcou.png')
        plt.savefig(plot_files['rcou'])
        plt.close()

    # XKF4 Plot
    if XKF4_data['Time']:
        plt.figure(figsize=(10, 6))
        keys = ['SV', 'SP', 'SH', 'SM', 'SVT']
        for key in keys:
            plt.plot(XKF4_data['Time'], XKF4_data[key], label=key)
        plt.xlabel("Time (s)")
        plt.ylabel("XKF4 Values")
        plt.title("XKF4 Data vs Time")
        plt.legend()
        plt.grid()
        plt.tight_layout()
        plot_files['xkf4'] = os.path.join(plot_dir, 'xkf4.png')
        plt.savefig(plot_files['xkf4'])
        plt.close()

    return plot_files
def anonymize_gps_log(input_path, output_path):
    with open(input_path, 'r') as f:
        lines = f.readlines()

    output_lines = []

    # Confirmed field index mapping from your log
    field_indices = {
        "GPS":   {"Lat": 7, "Lng": 8, "Alt": 9},
        "AHR2":  {"Lat": 6, "Lng": 7},
        "EAHR":  {"Lat": 5, "Lng": 6},  # assumed
        "POS":   {"Lat": 2, "Lng": 3},  # ✅ corrected
        "TERR":  {"Lat": 3, "Lng": 4},  # ✅ corrected
        "ORGN":  {"Lat": 3, "Lng": 4}
    }

    for line in lines:
        line_stripped = line.strip()
        for msg_type, fields in field_indices.items():
            if line_stripped.startswith(msg_type):
                parts = line_stripped.split(',')
                try:
                    for field_name, index in fields.items():
                        if len(parts) > index:
                            parts[index] = "0"
                    line = ','.join(parts) + '\n'
                except IndexError:
                    pass
                break  # don't process the same line more than once
        output_lines.append(line)

    with open(output_path, 'w') as f:
        f.writelines(output_lines)
    
# Routes
@app.route('/login')
def login():
    redirect_uri = url_for('authorize', _external=True)
    return github.authorize_redirect(redirect_uri)

@app.route('/authorize')
def authorize():
    token = github.authorize_access_token()
    resp = github.get('user')
    user_info = resp.json()
    github_id = str(user_info['id'])
    username = user_info['login']

    with sqlite3.connect(DATABASE) as conn:
        c = conn.cursor()
        c.execute('SELECT id FROM users WHERE github_id = ?', (github_id,))
        user = c.fetchone()
        if not user:
            c.execute('INSERT INTO users (github_id, username) VALUES (?, ?)', (github_id, username))
            conn.commit()
            c.execute('SELECT id FROM users WHERE github_id = ?', (github_id,))
            user = c.fetchone()
        user_id = user[0]
        login_user(User(user_id, github_id, username))
    return redirect(url_for('upload_file'))

@app.route('/logout')
@login_required
def logout():
    # Log out the user
    logout_user()
    
    # Clear the session data to reset GitHub authentication credentials
    session.clear()
    
    # Redirect to the logout confirmation page or login page
    return redirect(url_for('logout_confirmation'))

@app.route('/logout_confirmation')
def logout_confirmation():
    # Log out the user
    logout_user()
    
    # Clear the session data to reset GitHub authentication credentials
    session.clear()
    return render_template('logout_confirmation.html')

@app.route('/', methods=['GET', 'POST'])
@login_required
def upload_file():
    global progress_tracker
    progress_tracker = {'progress': 0, 'total_steps': 5}  # Reset progress

    if request.method == 'POST':
        uploaded_files = {'log': None, 'markdown': None, 'videos': []}
        markdown_content = None
        anonymized_file_path = None

        # Step 1: Handle log file
        if 'file' in request.files:
            log_file = request.files['file']
            if log_file.filename.endswith(('.BIN', '.log')):  # Accept both .BIN and .log files
                log_filepath = os.path.join(app.config['UPLOAD_FOLDER'], f"{current_user.id}_{log_file.filename}")
                log_file.save(log_filepath)
                uploaded_files['log'] = log_filepath
                progress_tracker['progress'] += 1  # Increment progress

                # Anonymize the log file if requested
                if 'anonymize' in request.form and log_file.filename.endswith('.log'):
                    output_file_name = request.form.get('output_file_name', 'anonymized.log')
                    anonymized_file_path = os.path.join(app.config['UPLOAD_FOLDER'], output_file_name)
                    anonymize_gps_log(log_filepath, anonymized_file_path)
                    uploaded_files['log'] = anonymized_file_path  # Replace with anonymized file

        # Step 2: Handle markdown file
        if 'markdown' in request.files:
            markdown_file = request.files['markdown']
            if markdown_file.filename.endswith('.md'):
                markdown_filepath = os.path.join(app.config['UPLOAD_FOLDER'], f"{current_user.id}_{markdown_file.filename}")
                markdown_file.save(markdown_filepath)
                uploaded_files['markdown'] = markdown_filepath
                with open(markdown_filepath, 'r') as f:
                    markdown_content = markdown.markdown(f.read(), extensions=['fenced_code', 'tables'])
                progress_tracker['progress'] += 1  # Increment progress

        # Step 3: Handle video files
        if 'videos' in request.files:
            video_files = request.files.getlist('videos')
            for video_file in video_files:
                if video_file.filename:
                    video_filepath = os.path.join(app.config['UPLOAD_FOLDER'], f"{current_user.id}_{video_file.filename}")
                    video_file.save(video_filepath)
                    uploaded_files['videos'].append(video_filepath)
            progress_tracker['progress'] += 1  # Increment progress

        # Step 4: Save session to database
        with sqlite3.connect(DATABASE) as conn:
            c = conn.cursor()
            videos_str = ','.join(uploaded_files['videos']) if uploaded_files['videos'] else None
            c.execute('''INSERT INTO sessions (user_id, log_file, markdown_file, videos, created_at)
                         VALUES (?, ?, ?, ?, ?)''',
                      (current_user.id, uploaded_files['log'], uploaded_files['markdown'], videos_str, datetime.utcnow()))
            conn.commit()
        progress_tracker['progress'] += 1  # Increment progress

        # Step 5: Process log file if present
        plot_files = {}
        if uploaded_files['log']:
            data = parse_log(uploaded_files['log'])
            plot_files = generate_plots(*data, app.config['PLOT_FOLDER'])
            progress_tracker['progress'] += 1  # Increment progress

        return render_template('results.html', plot_files=plot_files, uploaded_files=uploaded_files, markdown_content=markdown_content)

    # Fetch user sessions
    with sqlite3.connect(DATABASE) as conn:
        c = conn.cursor()
        c.execute('SELECT id, log_file, markdown_file, videos, created_at FROM sessions WHERE user_id = ? ORDER BY created_at DESC', (current_user.id,))
        sessions = c.fetchall()
        sessions = [{
            'id': s[0],
            'log_file': s[1],
            'markdown_file': s[2],
            'videos': s[3].split(',') if s[3] else [],
            'created_at': s[4]
        } for s in sessions]
    return render_template('upload.html', sessions=sessions)

from flask import jsonify

progress_tracker = {'progress': 0, 'total_steps': 5}  # Global variable to track progress

@app.route('/progress', methods=['GET'])
@login_required
def get_progress():
    return jsonify(progress_tracker)

@app.route('/session/<int:session_id>')
@login_required
def view_session(session_id):
    with sqlite3.connect(DATABASE) as conn:
        c = conn.cursor()
        c.execute('SELECT user_id, log_file, markdown_file, videos FROM sessions WHERE id = ?', (session_id,))
        session_data = c.fetchone()
        if not session_data or session_data[0] != current_user.id:
            return "Unauthorized", 403
        uploaded_files = {
            'log': session_data[1],
            'markdown': session_data[2],
            'videos': session_data[3].split(',') if session_data[3] else []
        }
        markdown_content = None
        if uploaded_files['markdown']:
            with open(uploaded_files['markdown'], 'r') as f:
                markdown_content = markdown.markdown(f.read(), extensions=['fenced_code', 'tables'])
        plot_files = {}
        if uploaded_files['log']:
            data = parse_log(uploaded_files['log'])
            plot_files = generate_plots(*data, app.config['PLOT_FOLDER'])
        return render_template('results.html', plot_files=plot_files, uploaded_files=uploaded_files, markdown_content=markdown_content)

@app.route('/static/plots/<filename>')
def serve_plot(filename):
    return send_from_directory(app.config['PLOT_FOLDER'], filename)

@app.route('/uploads/<filename>')
def serve_uploaded_file(filename):
    return send_from_directory(app.config['UPLOAD_FOLDER'], filename)

if __name__ == "__main__":
    app.run(debug=True, host='0.0.0.0', port=5000)