process.once('message', message => {
  process.send({...message,pid:process.pid}, () => process.disconnect());
});
