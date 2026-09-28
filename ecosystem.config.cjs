module.exports = {
  apps: [
    {
      name: "rfc-review-studio",
      cwd: __dirname,
      script: "dist/server/index.js",
      node_args: "--env-file-if-exists=.env",
      instances: 1,
      exec_mode: "fork",
      autorestart: true,
      restart_delay: 3000,
      kill_timeout: 15000,
      time: true,
      env: { NODE_ENV: "production" },
    },
  ],
};
