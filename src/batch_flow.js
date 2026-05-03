function decideNextProductTransition({ moved, ready, productInfo }) {
  if (!moved || !moved.success) {
    return {
      continueBatch: false,
      reason: moved && moved.reason ? moved.reason : 'No next product entry was found.'
    };
  }

  if (!ready) {
    const title = productInfo && productInfo.title ? productInfo.title : '(unknown title)';
    return {
      continueBatch: false,
      reason: `Clicked next product but the page did not switch. Stop batch to avoid editing the same product again: ${title}`
    };
  }

  return {
    continueBatch: true,
    reason: moved.reason || ''
  };
}

module.exports = {
  decideNextProductTransition
};
