# Nagios Core check engine for the Watcher stack.
# Uses the well-maintained community image; Watcher-specific object config is
# mounted at /usr/local/nagios/etc/objects/watcher (see docker-compose.yml).
FROM jasonrivers/nagios:latest

# Make sure the external command file is enabled and status.dat refreshes fast
# enough for near-real-time dashboards.
RUN sed -i \
      -e 's/^status_update_interval=.*/status_update_interval=5/' \
      -e 's/^check_external_commands=.*/check_external_commands=1/' \
      /opt/nagios/etc/nagios.cfg || true

# Load the Watcher-managed object directory if present.
RUN grep -q 'objects/watcher' /opt/nagios/etc/nagios.cfg 2>/dev/null || \
    echo 'cfg_dir=/usr/local/nagios/etc/objects/watcher' >> /opt/nagios/etc/nagios.cfg || true
