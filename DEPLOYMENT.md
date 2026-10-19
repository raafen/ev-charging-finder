# Deploy on AWS EC2 (Ubuntu)

These are manual deployment instructions; no AWS resources are created by this repository. AWS usage may incur charges. Follow the current [EC2 instance launch documentation](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/EC2_GetStarted.html).

1. Launch an Ubuntu EC2 instance and select an SSH key you control. Configure the security group to allow SSH (22) only from your IP. For initial testing, allow TCP 8000 only from your IP too. Keep the API key out of instance user data and Git history.
2. Connect using the SSH instructions in the AWS console. Install dependencies:

```bash
sudo apt update
sudo apt install -y python3-venv git
```

3. Clone your own repository, create a virtual environment, and run the tests:

```bash
git clone https://github.com/YOUR_USERNAME/ev-charging-finder.git
cd ev-charging-finder
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
.venv/bin/python -m unittest discover -s tests -v
```

4. Run Gunicorn for an initial remote check. Enter your API key when prompted (input is hidden):

```bash
read -s -p 'Open Charge Map API key: ' OCM_API_KEY
export OCM_API_KEY
.venv/bin/gunicorn --bind 0.0.0.0:8000 --workers 2 --timeout 35 app:app
```

Open `http://YOUR_INSTANCE_PUBLIC_IP:8000` from the IP allowed by the security group. Verify both demo and real searches. This process stops when its terminal session ends. For a persistent service, configure systemd with an EnvironmentFile readable only by the service user; run Gunicorn as an unprivileged user. For public access, place Nginx and HTTPS in front of Gunicorn, bind Gunicorn to localhost, remove public access to 8000, and expose 443 through the security group. Add rate limiting before broadly sharing the service.

Record a screenshot of the working page and the deployment steps you completed. Stop or terminate unused instances and review attached storage/network resources to avoid ongoing charges. Do not commit SSH keys, API keys, or environment files.
