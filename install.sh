#! /bin/bash
cp run_sensorconfig_frontend.service /lib/systemd/system
systemctl daemon-reload
systemctl enable run_sensorconfig_frontend
systemctl start run_sensorconfig_frontend