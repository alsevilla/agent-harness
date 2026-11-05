# Harness Serena server, started by serena.mjs with the Python of the installed serena-agent (uv tool install serena-agent).
# It is Serena's own read-only project server (serena.project_server) with these changes, all in this process only:
#   1. the tool interface is always used: Serena 2.x defaults new configurations to its REPL interface, where find_symbol and the other
#      lookup tools are not active (the global Serena configuration file is not changed);
#   2. a project that already has .serena/project.yml is registered on its first query, so no restart is needed;
#   3. a failing query returns its error text (HTTP 400) instead of an empty 500 page;
#   4. the process exits after HARNESS_SERENA_IDLE_SECONDS without queries (default 1800), so it never lingers;
#   5. an /outline route returns a file's symbols with line ranges (Serena's overview tool has names only).
# Only read-only tools can run through /query_project; Serena refuses any other tool.
import json
import os
import sys
import threading
import time

from flask import Response, request
from werkzeug.exceptions import HTTPException

from serena import project_server
from serena.config import serena_config


def _tools_interface(self, project_config=None, log_choice=False):
    return serena_config.AgentInterface.TOOLS


serena_config.SerenaConfig.determine_agent_interface = _tools_interface

IDLE_SECONDS = float(os.environ.get("HARNESS_SERENA_IDLE_SECONDS", "1800"))
_last_use = [time.monotonic()]


class HarnessProjectServer(project_server.ProjectServer):
    def _get_project(self, project_root_or_name):
        config = self._agent.serena_config
        if config.get_registered_project(project_root_or_name) is None:
            config.get_registered_project(project_root_or_name, autoregister=True)
        return super()._get_project(project_root_or_name)


def main():
    port = int(sys.argv[1])
    server = HarnessProjectServer(host="127.0.0.1", port=port)
    app = server._app

    @app.before_request
    def _touch():
        _last_use[0] = time.monotonic()

    # Serena's overview tool returns names grouped by kind, without lines; an outline is only useful with line ranges, so this route
    # returns each top-level symbol and its direct children with kind and body location (0-based lines, as Serena reports them).
    @app.route("/outline", methods=["POST"])
    def _outline():
        from serena.repl.api.lsp_api import LspApi

        data = request.get_json()
        project = server._get_project(data["project_name"])
        relative_path = data["relative_path"]
        with server._active_project_lock, server._agent.active_project_context(project):
            def task():
                collection = LspApi(server._agent).get_symbols_overview(relative_path, depth=1)
                return [s.to_dict(name_path=True, kind=True, body_location=True, depth=1) for s in collection.symbols]

            symbols = server._agent.execute_task(task)
        return Response(json.dumps(symbols), mimetype="application/json")

    @app.errorhandler(Exception)
    def _error(error):
        if isinstance(error, HTTPException):
            return error
        return Response(f"{type(error).__name__}: {error}", status=400, mimetype="text/plain")

    def _watchdog():
        while True:
            time.sleep(30)
            if time.monotonic() - _last_use[0] > IDLE_SECONDS:
                os._exit(0)

    threading.Thread(target=_watchdog, daemon=True).start()
    server.run()


if __name__ == "__main__":
    main()
