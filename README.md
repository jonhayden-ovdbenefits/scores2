# Scores

Live scoreboard page: favorite teams first, then the day's big games, then every league. Scores come from ESPN's public scoreboard feed, loaded in the browser.

Teams and leagues are set at the top of the script in `index.html`.

## Bears TV check (Grand Rapids)

`tools/bears-tv.js` reads [506sports.com](https://506sports.com/nfl/index-m.php)'s coverage maps and saves whether the Grand Rapids market gets the Bears game to `bears-tv.json`. The Bears card shows it as a "Local TV" line, and Jon's Brief reads the same file. It runs Wednesday, Friday, Saturday evening and early Sunday (`.github/workflows/bears-tv.yml`); run it by hand from the Actions tab.

Regional games are read off the map: the colour at Grand Rapids is matched to each game's swatch. If 506 changes its base map the check reports that it couldn't read the map rather than guessing.
