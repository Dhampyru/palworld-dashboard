# Game-data extractor (runtime clean-room path).
# Builds the ported PalworldDataExtractor fork and pairs it with convert.py so
# one `docker run` turns the operator's OWN pak + usmap into the dashboard's
# picker datasets (data/*.json) + Pal icons. Nothing of Pocketpair's is baked in
# — the pak and usmap are mounted at run time, and only the operator's own
# extracted data is written out.
#
# Build context is the repo root:
#   docker build -f tools/game-data-extractor/Dockerfile -t palworld-data-extractor .
ARG PDE_FORK=https://github.com/Dhampyru/PalworldDataExtractor
ARG PDE_SHA=5efb9e98522f

FROM mcr.microsoft.com/dotnet/sdk:10.0 AS build
ARG PDE_FORK
ARG PDE_SHA
WORKDIR /src
RUN git clone "$PDE_FORK" pde && git -C pde checkout --quiet "$PDE_SHA"
RUN dotnet publish pde/Cli/Cli.csproj -c Release -r linux-x64 --self-contained true \
      -p:PublishSingleFile=false -o /extractor

FROM mcr.microsoft.com/dotnet/runtime-deps:10.0 AS runner
RUN apt-get update && apt-get install -y --no-install-recommends python3 \
    && rm -rf /var/lib/apt/lists/*
COPY --from=build /extractor /opt/extractor
COPY scripts/pde/convert.py /opt/convert.py
COPY tools/game-data-extractor/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh
# Mount at run time: /paks (ro, the game's Content/Paks), /mappings.usmap (ro),
# /data (datasets out), /icons (icons out).
ENTRYPOINT ["/entrypoint.sh"]
