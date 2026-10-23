// Resolved instead of the real entry points when a bundler targets the browser.
throw new Error(
  '@cauce/server holds the relayer key and must only run on the server. ' +
    'Import @cauce/core or @cauce/react in client code instead.',
);
