import React, { createContext, useState, useContext } from 'react';

const Libp2pContext = createContext();

export const useLibp2p = () => useContext(Libp2pContext);

export const Libp2pProvider = ({ children }) => {
  const [libp2pState, setLibp2pState] = useState(null);
  const [topics, setTopics] = useState([]);
  const [signal, setSignal ] = useState(1)


  return (
    <Libp2pContext.Provider value={{ libp2pState, setLibp2pState, topics, setTopics, signal,  setSignal}}>
      {children}
    </Libp2pContext.Provider>
  );
};