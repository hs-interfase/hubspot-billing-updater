import pino from "pino"

const logger = pino({
  level: "info",
  base: null,
  timestamp: pino.stdTimeFunctions.isoTime
})

export default logger
