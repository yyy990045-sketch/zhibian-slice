// run-lifecycle.js — 研究运行的异步生命周期控制器。
// 每次新搜索/收藏夹运行都会作废旧搜索和直答；离开结果页也会同时 abort。

function abort(controller) {
  controller?.abort();
}

export function createRunController() {
  let generation = 0;
  let searchController = null;
  let directAnswerController = null;

  return {
    beginSearch() {
      abort(searchController);
      abort(directAnswerController);
      searchController = new AbortController();
      directAnswerController = null;
      return { id: ++generation, signal: searchController.signal };
    },

    beginDirectAnswer() {
      abort(directAnswerController);
      directAnswerController = new AbortController();
      return { id: generation, signal: directAnswerController.signal };
    },

    invalidate() {
      abort(searchController);
      abort(directAnswerController);
      searchController = null;
      directAnswerController = null;
      return ++generation;
    },
  };
}
