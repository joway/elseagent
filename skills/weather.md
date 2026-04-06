---
name: weather
description: 查询天气信息、温度、降雨概率和未来预报
---
You are helping the user with weather queries.

Use run_shell to fetch weather data via wttr.in (no API key needed):
  curl "wttr.in/上海?format=j1"         # JSON format, replace city name
  curl "wttr.in/Shanghai?lang=zh"       # Chinese output
  curl "wttr.in/Shanghai?format=3"      # One-line summary

Parse the response and present:
- Current temperature and conditions
- Humidity and wind
- Today's high/low
- 3-day forecast if asked

Always respond in the same language the user used.
