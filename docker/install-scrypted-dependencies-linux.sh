#!/usr/bin/env bash

if [ "$USER" != "root" ]
then
    echo "Installation must be run as 'root' (use sudo)."
    exit 1
fi

# bad hack to run a dockerfile like a shell script.

RUN() {
    echo "Running: $@"
    $@
    if [ "$?" != "0" ]
    then
        echo 'Error during previous command.'
        exit 1
    fi
}

FROM() {
    echo 'Installing nodejs repo'
    RUN curl -fsSL https://deb.nodesource.com/setup_lts.x | bash -
    RUN apt-get update
    RUN apt-get install -y nodejs
}

ARG() {
    echo "ignoring ARG $1"
}

ENV() {
    echo "ignoring ENV $1"
}

source <(curl -s https://raw.githubusercontent.com/CaseyTal/scrypted/main/docker/Dockerfile.common)

if [ -z "$SERVICE_USER" ]
then
    echo "Scrypted SERVICE_USER environment variable was not specified. Service will not be installed."
    exit 0
fi

if [ "$SERVICE_USER" == "root" ]
then
    echo "Scrypted SERVICE_USER root is not allowed."
    exit 1
fi


# this is not RUN as we do not care about the result
echo "Setting permissions on /home/$SERVICE_USER/.scrypted"
chown -R $SERVICE_USER /home/$SERVICE_USER/.scrypted

echo "Installing Scrypted..."
RUN sudo -u $SERVICE_USER npx -y scrypted install-server

cat <<EOT > /etc/systemd/system/scrypted.service

[Unit]
Description=Scrypted service
After=network.target

[Service]
User=$SERVICE_USER
Group=$SERVICE_USER
Type=simple
ExecStart=/usr/bin/npx -y scrypted serve
Restart=on-failure
RestartSec=3

[Install]
WantedBy=multi-user.target

EOT

RUN systemctl daemon-reload
RUN systemctl enable scrypted.service
RUN systemctl restart scrypted.service


set +x
echo
echo
echo
echo
echo "Scrypted Service has been installed (and started). You can start, stop, enable, or disable Scrypted with:"
echo "  systemctl start scrypted.service"
echo "  systemctl stop scrypted.service"
echo "  systemctl enable scrypted.service"
echo "  systemctl disable scrypted.service"
echo
echo "Scrypted is now running at: https://localhost:10443/"
echo "Note that it is https and that you'll be asked to approve/ignore the website certificate."
echo
echo
